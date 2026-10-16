/**
 * Devnet setup. Safe to re-run.
 *
 * Creates whatever is missing - the vault keypair, the two project mints,
 * the vault's token accounts - and reuses whatever already exists:
 *
 *   vault   .vault.json
 *   mints   DEVNET_USDC_MINT / DEVNET_USDT_MINT from the environment or .env,
 *           else .mints.json
 *
 * A mint is only created when no address for it is configured anywhere.
 * Every wallet balance lives in a token account of a specific mint, so a new
 * mint silently orphans all of them; a configured address that turns out to
 * be wrong (missing on devnet, or not controlled by this vault) stops the
 * script with an explanation instead.
 *
 *   node scripts/setup-devnet.mjs
 */

import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

// Values already in the environment win over .env, as everywhere else.
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const RPC = process.env.DEVNET_RPC_URL || clusterApiUrl("devnet");
const VAULT_FILE = path.resolve(process.cwd(), ".vault.json");
const MINTS_FILE = path.resolve(process.cwd(), ".mints.json");

const MINT_DECIMALS = 6;
const LABELS = ["USDC", "USDT"];

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

/**
 * The configured address for a mint, if any, and where it came from.
 * The environment (including .env) wins over .mints.json.
 */
function configuredMint(label) {
  const fromEnv = process.env[`DEVNET_${label}_MINT`]?.trim();
  if (fromEnv) return { address: fromEnv, source: `DEVNET_${label}_MINT` };

  if (fs.existsSync(MINTS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(MINTS_FILE, "utf8"))[label];
    if (saved) return { address: saved, source: ".mints.json" };
  }

  return null;
}

/** Throws unless the address is a 6-decimal mint this vault can mint from. */
async function verifyMint(label, { address, source }, vault) {
  let key;
  try {
    key = new PublicKey(address);
  } catch {
    throw new Error(`${source} for ${label} is "${address}", which is not a valid Solana address.`);
  }

  const info = (await connection.getParsedAccountInfo(key)).value;
  const parsed = info?.data?.parsed;

  if (!info || parsed?.type !== "mint") {
    throw new Error(`${source} for ${label} points at ${address}, which is not a mint on devnet.`);
  }
  if (parsed.info.decimals !== MINT_DECIMALS) {
    throw new Error(`${label} mint ${address} has ${parsed.info.decimals} decimals; the app expects ${MINT_DECIMALS}.`);
  }
  if (parsed.info.mintAuthority !== vault.publicKey.toBase58()) {
    throw new Error(
      `${label} mint ${address} is controlled by ${parsed.info.mintAuthority}, not by this vault ` +
        `(${vault.publicKey.toBase58()}). The vault must be its mint authority to fund wallets.`,
    );
  }

  return key;
}

async function ensureFunded(vault, { required }) {
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
    if (!required) {
      console.warn(
        `\nThe vault holds ${(balance / LAMPORTS_PER_SOL).toFixed(2)} SOL and the faucet would not top it up.\n` +
          "Nothing needs creating, so setup carries on; airdrop to the vault before funding many wallets.",
      );
      return;
    }

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

  const configured = Object.fromEntries(LABELS.map((label) => [label, configuredMint(label)]));
  const toCreate = LABELS.filter((label) => !configured[label]);

  await ensureFunded(vault, { required: toCreate.length > 0 });

  const mints = {};
  for (const label of LABELS) {
    if (configured[label]) {
      mints[label] = await verifyMint(label, configured[label], vault);
      console.log(`Reusing the ${label} mint from ${configured[label].source}: ${mints[label].toBase58()}`);
    } else {
      mints[label] = await createProjectMint(vault, label);
    }
  }

  fs.writeFileSync(
    MINTS_FILE,
    JSON.stringify(Object.fromEntries(LABELS.map((l) => [l, mints[l].toBase58()])), null, 2) + "\n",
  );

  console.log(toCreate.length ? "\nAdd these to your .env file:\n" : "\nNothing new was created. Your .env should contain:\n");
  console.log(`DEVNET_USDC_MINT=${mints.USDC.toBase58()}`);
  console.log(`DEVNET_USDT_MINT=${mints.USDT.toBase58()}`);
  console.log(`VAULT_SECRET_KEY=${Array.from(vault.secretKey).join(",")}`);
  console.log(
    `\nVault on Solscan: https://solscan.io/account/${vault.publicKey.toBase58()}?cluster=devnet`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
