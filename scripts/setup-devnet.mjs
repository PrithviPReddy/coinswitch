/**
 * One-time devnet setup.
 *
 * Creates the vault keypair, the two project mints, and the vault's own token
 * accounts, then prints the environment lines the app needs. Safe to re-run:
 * an existing .vault.json is reused rather than replaced.
 *
 *   node scripts/setup-devnet.mjs
 */

import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

const RPC = process.env.DEVNET_RPC_URL ?? clusterApiUrl("devnet");
const VAULT_FILE = path.resolve(process.cwd(), ".vault.json");

const connection = new Connection(RPC, "confirmed");

function loadOrCreateVault() {
  if (fs.existsSync(VAULT_FILE)) {
    const secret = JSON.parse(fs.readFileSync(VAULT_FILE, "utf8"));
    console.log("Reusing existing vault from .vault.json");
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }

  const keypair = Keypair.generate();
  fs.writeFileSync(VAULT_FILE, JSON.stringify(Array.from(keypair.secretKey)));
  console.log("Created a new vault keypair and wrote it to .vault.json");
  return keypair;
}

async function ensureFunded(vault) {
  const target = 2 * LAMPORTS_PER_SOL;
  let balance = await connection.getBalance(vault.publicKey);

  if (balance >= target) {
    console.log(`Vault holds ${(balance / LAMPORTS_PER_SOL).toFixed(2)} SOL`);
    return;
  }

  console.log("Requesting a devnet airdrop for the vault...");

  // The public faucet rate limits aggressively, so this backs off rather than
  // failing on the first refusal.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const signature = await connection.requestAirdrop(
        vault.publicKey,
        1 * LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(signature, "confirmed");
      balance = await connection.getBalance(vault.publicKey);
      console.log(
        `  airdrop ${attempt}: vault now holds ${(balance / LAMPORTS_PER_SOL).toFixed(2)} SOL`,
      );
      if (balance >= target) return;
    } catch {
      console.log(`  airdrop ${attempt} refused, waiting before retrying`);
      await new Promise((r) => setTimeout(r, attempt * 4000));
    }
  }

  if (balance < 0.5 * LAMPORTS_PER_SOL) {
    console.error(
      "\nThe faucet would not fund the vault. Send it devnet SOL manually:\n" +
        `  solana airdrop 2 ${vault.publicKey.toBase58()} --url devnet\n` +
        "or use https://faucet.solana.com, then re-run this script.",
    );
    process.exit(1);
  }
}

async function createProjectMint(vault, label) {
  console.log(`Creating the ${label} mint...`);

  const mint = await createMint(
    connection,
    vault,
    vault.publicKey, // mint authority stays with the vault so it can top wallets up
    null,
    6,
  );

  const vaultAta = await getOrCreateAssociatedTokenAccount(
    connection,
    vault,
    mint,
    vault.publicKey,
  );

  await mintTo(
    connection,
    vault,
    mint,
    vaultAta.address,
    vault,
    1_000_000_000_000, // one million tokens at six decimals
  );

  console.log(`  ${label}: ${mint.toBase58()}`);
  return mint;
}

async function main() {
  console.log(`Devnet RPC: ${RPC}\n`);

  const vault = loadOrCreateVault();
  console.log(`Vault address: ${vault.publicKey.toBase58()}\n`);

  await ensureFunded(vault);

  const usdc = await createProjectMint(vault, "USDC");
  const usdt = await createProjectMint(vault, "USDT");

  console.log("\nAdd these to your .env file:\n");
  console.log(`DEVNET_USDC_MINT=${usdc.toBase58()}`);
  console.log(`DEVNET_USDT_MINT=${usdt.toBase58()}`);
  console.log(`VAULT_SECRET_KEY=${Array.from(vault.secretKey).join(",")}`);
  console.log(
    `\nVault on Solscan: https://solscan.io/account/${vault.publicKey.toBase58()}?cluster=devnet`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
