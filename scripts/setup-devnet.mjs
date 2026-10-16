/**
 * Devnet setup. Safe to re-run.
 *
 * Creates whatever is missing - the vault keypair, the five project mints
 * (devnet stand-ins for USDC, USDT, JUP, BONK and WIF), the vault's token
 * accounts - and reuses whatever already exists:
 *
 *   vault   .vault.json
 *   mints   DEVNET_<TOKEN>_MINT from the environment or .env, else .mints.json
 *
 * It also keeps the vault stocked with about VAULT_STOCK_USD (default $5M)
 * of each token at mainnet prices, so it can pay out a large demo trade.
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
  SystemProgram,
  Transaction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";

// Values already in the environment win over .env, as everywhere else.
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const RPC = process.env.DEVNET_RPC_URL || clusterApiUrl("devnet");
const VAULT_FILE = path.resolve(process.cwd(), ".vault.json");
const MINTS_FILE = path.resolve(process.cwd(), ".mints.json");

/**
 * The project's devnet stand-ins. Each copies the decimals of the mainnet
 * token it stands in for (read from the mainnet mint accounts on 2026-10-16)
 * so a mainnet quote's base units settle unchanged. mainnet is used only to
 * look up a USD price for sizing the vault's stock.
 */
const TOKENS = [
  { label: "USDC", decimals: 6, mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { label: "USDT", decimals: 6, mainnet: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
  { label: "JUP", decimals: 6, mainnet: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { label: "BONK", decimals: 5, mainnet: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  { label: "WIF", decimals: 6, mainnet: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
];
const LABELS = TOKENS.map((t) => t.label);

/**
 * What the vault holds of each token, in USD, so it can pay out the largest
 * demo trade ($200k) many times over. Sized by notional because unit counts
 * mean nothing across tokens: 500 BONK is about a cent.
 */
const VAULT_STOCK_USD = Number(process.env.VAULT_STOCK_USD || 5_000_000);

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

/** Throws unless the address is a mint of the right decimals this vault can mint from. */
async function verifyMint({ label, decimals }, { address, source }, vault) {
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
  if (parsed.info.decimals !== decimals) {
    throw new Error(`${label} mint ${address} has ${parsed.info.decimals} decimals; the app expects ${decimals}.`);
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
      // Polled, not confirmTransaction: see sendAndConfirmHttp.
      for (let i = 0; i < 30; i++) {
        const status = (await connection.getSignatureStatuses([signature])).value[0];
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
        await sleep(1000);
      }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends and confirms by polling over HTTP, as app/lib/devnet.ts does, rather
 * than through web3.js's confirmTransaction. That opens a signatureSubscribe
 * WebSocket, which some hosted RPCs (Alchemy among them) do not implement:
 * the wait then runs out and reports "expired" for a transaction that in
 * fact landed. Resolves once confirmed; throws only when it is known not to
 * have applied, or when the outcome is still unknown after the blockhash
 * expired and a final history search.
 */
async function sendAndConfirmHttp(instructions, signers) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(
    ...instructions,
  );
  tx.sign(...signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });

  for (;;) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.err) throw new Error(`Transaction ${signature} failed on chain: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return signature;
    }

    if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      const final = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))
        .value[0];
      if (final && !final.err) return signature;
      throw new Error(`Transaction ${signature} expired without landing. Re-run to try again.`);
    }

    await sleep(1000);
  }
}

/** Mints recorded before their creating transaction is sent; see createProjectMint. */
function readMintsFile() {
  return fs.existsSync(MINTS_FILE) ? JSON.parse(fs.readFileSync(MINTS_FILE, "utf8")) : {};
}

function writeMintsFile(contents) {
  fs.writeFileSync(MINTS_FILE, JSON.stringify(contents, null, 2) + "\n");
}

/**
 * Creates a mint whose address is chosen here and written to .mints.json
 * under "pending" before the transaction is sent. If the run dies or the
 * confirmation is lost, the next run finds the pending address, sees whether
 * it landed, and adopts it, so an interrupted run can never leave an orphan
 * mint and then create a second one.
 */
async function createProjectMint(vault, { label, decimals }) {
  const mintKeypair = Keypair.generate();

  const recorded = readMintsFile();
  recorded.pending = { ...recorded.pending, [label]: mintKeypair.publicKey.toBase58() };
  writeMintsFile(recorded);

  console.log(`Creating the ${label} mint (${decimals} decimals): ${mintKeypair.publicKey.toBase58()}`);

  await sendAndConfirmHttp(
    [
      SystemProgram.createAccount({
        fromPubkey: vault.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: MINT_SIZE,
        lamports: await getMinimumBalanceForRentExemptMint(connection),
        programId: TOKEN_PROGRAM_ID,
      }),
      // Mint authority stays with the vault so it can top wallets up.
      createInitializeMint2Instruction(mintKeypair.publicKey, decimals, vault.publicKey, null),
    ],
    [vault, mintKeypair],
  );

  return mintKeypair.publicKey;
}

/** A pending mint from an interrupted run, if it landed and is usable. */
async function adoptPendingMint(token, vault) {
  const pending = readMintsFile().pending?.[token.label];
  if (!pending) return null;

  try {
    const key = await verifyMint(token, { address: pending, source: ".mints.json (pending)" }, vault);
    console.log(`Adopting the ${token.label} mint left by an interrupted run: ${pending}`);
    return key;
  } catch {
    console.log(`The pending ${token.label} mint ${pending} never landed; creating a fresh one.`);
    return null;
  }
}

/** USD prices from Jupiter's mainnet price API. Read only. */
async function fetchUsdPrices() {
  const ids = TOKENS.map((t) => t.mainnet).join(",");
  const response = await fetch(`https://api.jup.ag/price/v3?ids=${ids}`, {
    headers: process.env.JUP_API_KEY ? { "x-api-key": process.env.JUP_API_KEY } : undefined,
  });
  if (!response.ok) throw new Error(`Jupiter price API answered ${response.status}`);

  const body = await response.json();
  const prices = {};
  for (const t of TOKENS) {
    const price = Number(body[t.mainnet]?.usdPrice);
    if (!(price > 0)) throw new Error(`No mainnet USD price for ${t.label}; cannot size the vault's stock.`);
    prices[t.label] = price;
  }
  return prices;
}

/**
 * Tops the vault's own token account up to VAULT_STOCK_USD of the token. It
 * only mints when the stock has fallen below half the target, so a re-run
 * normally changes nothing. Only the vault's account is touched; no user
 * balance moves.
 */
async function ensureVaultStock(vault, { label, decimals }, mint, usdPrice) {
  const ata = getAssociatedTokenAddressSync(mint, vault.publicKey);
  const target = BigInt(Math.floor((VAULT_STOCK_USD / usdPrice) * 10 ** decimals));

  let held = BigInt(0);
  try {
    held = (await getAccount(connection, ata)).amount;
  } catch {
    // No token account yet; it is created below.
  }

  if (held * BigInt(2) >= target) {
    console.log(`  vault ${label} stock: ${fmt(held, decimals)} (target ${fmt(target, decimals)}), fine`);
    return;
  }

  await sendAndConfirmHttp(
    [
      createAssociatedTokenAccountIdempotentInstruction(vault.publicKey, ata, vault.publicKey, mint),
      createMintToInstruction(mint, ata, vault.publicKey, target - held),
    ],
    [vault],
  );
  console.log(`  vault ${label} stock: ${fmt(held, decimals)} -> ${fmt(target, decimals)} (about $${VAULT_STOCK_USD.toLocaleString("en-US")})`);
}

const fmt = (units, decimals) => (Number(units) / 10 ** decimals).toLocaleString("en-US");

async function main() {
  // Host only: hosted RPC URLs carry their API key in the path.
  console.log(`Devnet RPC: ${new URL(RPC).host}\n`);

  const vault = loadOrCreateVault();
  console.log(`Vault address: ${vault.publicKey.toBase58()}\n`);

  const configured = Object.fromEntries(LABELS.map((label) => [label, configuredMint(label)]));
  const toCreate = LABELS.filter((label) => !configured[label]);

  await ensureFunded(vault, { required: toCreate.length > 0 });

  // Every configured mint is checked before anything is created, so a bad
  // address stops the run before it has changed anything on chain.
  const mints = {};
  for (const token of TOKENS) {
    if (!configured[token.label]) continue;
    mints[token.label] = await verifyMint(token, configured[token.label], vault);
    console.log(`Reusing the ${token.label} mint from ${configured[token.label].source}: ${mints[token.label].toBase58()}`);
  }

  // Each mint is saved the moment it exists, and its pending entry cleared,
  // so no later failure can lead a re-run to create it a second time.
  for (const token of TOKENS) {
    if (mints[token.label]) continue;

    mints[token.label] =
      (await adoptPendingMint(token, vault)) ?? (await createProjectMint(vault, token));

    const recorded = readMintsFile();
    recorded[token.label] = mints[token.label].toBase58();
    if (recorded.pending) delete recorded.pending[token.label];
    writeMintsFile(recorded);
  }

  const recorded = readMintsFile();
  for (const label of LABELS) recorded[label] = mints[label].toBase58();
  if (recorded.pending && !Object.keys(recorded.pending).length) delete recorded.pending;
  writeMintsFile(recorded);

  console.log("\nVault stock:");
  const prices = await fetchUsdPrices();
  for (const token of TOKENS) {
    await ensureVaultStock(vault, token, mints[token.label], prices[token.label]);
  }

  console.log(toCreate.length ? "\nAdd these to your .env file:\n" : "\nNothing new was created. Your .env should contain:\n");
  for (const label of LABELS) {
    console.log(`DEVNET_${label}_MINT=${mints[label].toBase58()}`);
  }
  console.log(`VAULT_SECRET_KEY=${Array.from(vault.secretKey).join(",")}`);
  console.log(
    `\nVault on Solscan: https://solscan.io/account/${vault.publicKey.toBase58()}?cluster=devnet`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
