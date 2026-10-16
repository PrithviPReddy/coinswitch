import {
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { devnetConnection, TokenDetails } from "./constants";

/**
 * A devnet mint the app needs is missing or malformed in the environment.
 * Raised at first use with the variable named, rather than surfacing later
 * as web3.js's "Invalid public key input".
 */
export class MintConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MintConfigError";
  }
}

/**
 * Settlement is known not to have applied: rejected before broadcast, failed
 * on chain, or expired unconfirmed. Only this may be recorded as Failed.
 */
export class SettlementNotAppliedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementNotAppliedError";
  }
}

/**
 * The transaction was broadcast but its fate is unknown: confirmation timed
 * out, or the RPC failed mid-wait. It may yet land, so it is never Failed.
 */
export class SettlementUncertainError extends Error {
  constructor(
    message: string,
    readonly signature: string,
  ) {
    super(message);
    this.name = "SettlementUncertainError";
  }
}

/** The token's devnet mint as a key, or a MintConfigError naming its variable. */
export function requireDevnetMint(token: TokenDetails): PublicKey {
  const variable = token.devnetMintEnv ?? `the devnet mint for ${token.name}`;
  const fix =
    "Run `npm run setup:devnet`, copy the DEVNET_USDC_MINT and DEVNET_USDT_MINT " +
    "lines it prints into .env, then restart the app (or recreate the container).";

  if (!token.devnetMint) {
    throw new MintConfigError(`${variable} is not set, so ${token.name} cannot move on devnet. ${fix}`);
  }

  try {
    return new PublicKey(token.devnetMint);
  } catch {
    throw new MintConfigError(
      `${variable} is set to "${token.devnetMint}", which is not a valid Solana address. ${fix}`,
    );
  }
}

/** How long to wait for a broadcast transaction before calling it uncertain. */
const CONFIRM_TIMEOUT_MS = Number(process.env.SETTLE_CONFIRM_TIMEOUT_MS || 60_000);

/**
 * The vault is a single devnet keypair that holds the project's own mints and
 * acts as counterparty to every swap. It is also fee payer, so a user wallet
 * with zero SOL can still trade - one less thing to go wrong in front of an
 * audience.
 */
export function loadVaultKeypair(): Keypair {
  const raw = process.env.VAULT_SECRET_KEY;

  if (!raw) {
    throw new Error(
      "VAULT_SECRET_KEY is not set. Run `npm run setup:devnet` and copy the " +
        "values it prints into your .env file.",
    );
  }

  return keypairFromSecret(raw);
}

/** Accepts either a JSON array or the comma-joined form already in the DB. */
export function keypairFromSecret(secret: string): Keypair {
  const trimmed = secret.trim();
  const parsed = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as number[])
    : trimmed.split(",").map(Number);

  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

export function toBaseUnits(amount: number, decimals: number): bigint {
  // Going through a fixed-point string avoids the float drift you get from
  // amount * 10 ** decimals once decimals reaches 9.
  const [whole, fraction = ""] = amount.toFixed(decimals).split(".");
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

export function fromBaseUnits(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Confirms by polling getSignatureStatuses rather than calling
 * connection.confirmTransaction.
 *
 * confirmTransaction opens a `signatureSubscribe` WebSocket subscription, and
 * several hosted RPC providers - Alchemy among them - do not implement that
 * method for Solana. The subscription then never fires, the await hangs, and
 * the failure surfaces much later as "block height exceeded" even though the
 * transaction landed. Polling over plain HTTP works on every provider.
 */
async function confirmSignature(
  signature: string,
  lastValidBlockHeight: number,
): Promise<void> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      const { value } = await devnetConnection.getSignatureStatuses([signature]);
      const status = value[0];

      if (status?.err) {
        throw new SettlementNotAppliedError(
          `Transaction ${signature} failed on chain: ${JSON.stringify(status.err)}`,
        );
      }

      if (
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      ) {
        return;
      }

      // Once the chain passes this height the blockhash can no longer be
      // included, so there is nothing left to wait for.
      const blockHeight = await devnetConnection.getBlockHeight("confirmed");

      if (blockHeight > lastValidBlockHeight) {
        // One last look through history before declaring it dead: a status
        // lookup can lag a transaction that landed in the final valid block.
        const { value: final } = await devnetConnection.getSignatureStatuses(
          [signature],
          { searchTransactionHistory: true },
        );
        if (final[0] && !final[0].err) return;

        throw new SettlementNotAppliedError(
          `Transaction ${signature} expired before confirming. It was not applied.`,
        );
      }

      await sleep(1000);
    }
  } catch (error) {
    if (error instanceof SettlementNotAppliedError) throw error;
    // The RPC failed while we were waiting. The transaction may still land.
    throw new SettlementUncertainError(
      `Lost contact with devnet while confirming ${signature}. It may still land; check Solscan before retrying.`,
      signature,
    );
  }

  throw new SettlementUncertainError(
    `Timed out waiting for ${signature}. It may still land; check Solscan before retrying.`,
    signature,
  );
}

export type SendHooks = {
  /**
   * Called with the signature once the transaction is signed and before it is
   * broadcast, so a caller can persist it first. If the process dies after
   * this point, the record still points at whatever happened on chain.
   */
  onSigned?: (signature: string) => Promise<void> | void;
};

/**
 * Signs, broadcasts and confirms a set of instructions over HTTP.
 *
 * Outcomes are typed so callers never have to guess:
 *   returns                    confirmed
 *   SettlementNotAppliedError  known not to have applied
 *   SettlementUncertainError   broadcast, fate unknown (record as Pending)
 * Anything thrown before onSigned runs happened before signing, so nothing
 * was sent.
 */
async function sendAndConfirm(
  instructions: TransactionInstruction[],
  signers: Keypair[],
  feePayer: PublicKey,
  hooks: SendHooks = {},
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await devnetConnection.getLatestBlockhash("confirmed");

  const transaction = new Transaction({
    feePayer,
    blockhash,
    lastValidBlockHeight,
  }).add(...instructions);

  transaction.sign(...signers);

  // The fee payer's signature is the transaction id, known before broadcast.
  const signature = bs58.encode(transaction.signature!);
  await hooks.onSigned?.(signature);

  try {
    await devnetConnection.sendRawTransaction(transaction.serialize(), {
      maxRetries: 3,
    });
  } catch (error) {
    // A preflight rejection means the RPC refused to forward it at all.
    if (error instanceof SendTransactionError) {
      throw new SettlementNotAppliedError(
        `Devnet rejected the transaction before broadcast: ${error.message}`,
      );
    }
    // Anything else (a dropped connection) may have happened after the RPC
    // accepted it, so it is not safe to call it failed.
    throw new SettlementUncertainError(
      `Could not confirm devnet received ${signature}. It may still land; check Solscan before retrying.`,
      signature,
    );
  }

  await confirmSignature(signature, lastValidBlockHeight);

  return signature;
}

/** Reads a devnet balance in base units, treating a missing ATA as zero. */
export async function readBalance(
  token: TokenDetails,
  owner: PublicKey,
): Promise<bigint> {
  if (token.native) {
    return BigInt(await devnetConnection.getBalance(owner));
  }

  const ata = getAssociatedTokenAddressSync(requireDevnetMint(token), owner);

  try {
    const account = await getAccount(devnetConnection, ata);
    return account.amount;
  } catch {
    return BigInt(0);
  }
}

/**
 * Headroom kept on top of whatever a transaction pays out, covering the
 * signature fee and any associated token account the vault creates for a
 * recipient on the way through.
 */
const VAULT_HEADROOM_LAMPORTS = BigInt(10_000_000);

/**
 * Fails before signing when the vault cannot cover what it is about to owe.
 *
 * Worth understanding why this happens at all: the project mints USDC and
 * USDT itself, so those never run out, but SOL can only come from the devnet
 * faucet. The vault pays SOL out on every swap that ends in SOL, on every
 * top-up, and as fee payer on everything, while receiving only self-minted
 * tokens in return. SOL is the one genuinely scarce asset here and it drains
 * in one direction.
 *
 * Without this check the shortfall surfaces as a raw simulation dump from the
 * System program, which tells a user nothing they can act on.
 */
export async function assertVaultCanPay(
  vault: PublicKey,
  lamportsOut: bigint,
  action: string,
): Promise<void> {
  const balance = BigInt(await devnetConnection.getBalance(vault));
  const needed = lamportsOut + VAULT_HEADROOM_LAMPORTS;

  if (balance >= needed) return;

  const have = fromBaseUnits(balance, 9);
  const want = fromBaseUnits(needed, 9);

  throw new Error(
    `The vault is out of devnet SOL: it holds ${have} and ${action} needs ` +
      `about ${want}. Airdrop more to ${vault.toBase58()} — ` +
      "faucet.solana.com gives a larger allowance than the public RPC.",
  );
}

/**
 * Builds the settlement leg of a swap: the user's input token moves to the
 * vault and the quoted output moves back, both inside one transaction. Either
 * both transfers land or neither does - there is no state where a user has
 * paid and not been paid.
 */
export async function settleSwap({
  userKeypair,
  inputToken,
  outputToken,
  inBaseUnits,
  outBaseUnits,
  onSigned,
}: {
  userKeypair: Keypair;
  inputToken: TokenDetails;
  outputToken: TokenDetails;
  inBaseUnits: bigint;
  outBaseUnits: bigint;
} & SendHooks): Promise<string> {
  const vault = loadVaultKeypair();
  const user = userKeypair.publicKey;

  // Only a native payout draws on the vault's SOL. A token payout is minted
  // stock and cannot run short, though the fee still has to be affordable.
  await assertVaultCanPay(
    vault.publicKey,
    outputToken.native ? outBaseUnits : BigInt(0),
    "this swap",
  );

  // A token payout comes out of the vault's own stock. Say so plainly when
  // that has run low, instead of letting the transfer fail in preflight.
  if (!outputToken.native) {
    const held = await readBalance(outputToken, vault.publicKey);
    if (held < outBaseUnits) {
      throw new SettlementNotAppliedError(
        `The vault holds ${fromBaseUnits(held, outputToken.decimals)} ${outputToken.name} and this ` +
          `swap pays out ${fromBaseUnits(outBaseUnits, outputToken.decimals)}. Run ` +
          "`npm run setup:devnet` to restock it.",
      );
    }
  }

  const instructions: TransactionInstruction[] = [];

  // Leg one: user pays the vault.
  if (inputToken.native) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: vault.publicKey,
        lamports: inBaseUnits,
      }),
    );
  } else {
    const mint = requireDevnetMint(inputToken);
    const from = getAssociatedTokenAddressSync(mint, user);
    const to = getAssociatedTokenAddressSync(mint, vault.publicKey);

    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        vault.publicKey,
        to,
        vault.publicKey,
        mint,
      ),
      createTransferCheckedInstruction(
        from,
        mint,
        to,
        user,
        inBaseUnits,
        inputToken.decimals,
      ),
    );
  }

  // Leg two: vault pays the user.
  if (outputToken.native) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: vault.publicKey,
        toPubkey: user,
        lamports: outBaseUnits,
      }),
    );
  } else {
    const mint = requireDevnetMint(outputToken);
    const from = getAssociatedTokenAddressSync(mint, vault.publicKey);
    const to = getAssociatedTokenAddressSync(mint, user);

    instructions.push(
      // Idempotent: costs nothing when the account already exists, and saves
      // a first-time user from a failed swap.
      createAssociatedTokenAccountIdempotentInstruction(
        vault.publicKey,
        to,
        user,
        mint,
      ),
      createTransferCheckedInstruction(
        from,
        mint,
        to,
        vault.publicKey,
        outBaseUnits,
        outputToken.decimals,
      ),
    );
  }

  return sendAndConfirm(instructions, [vault, userKeypair], vault.publicKey, {
    onSigned,
  });
}

/** SOL each top-up sends. Small, because the vault's SOL only drains. */
export const FUND_SOL_TOPUP = Number(process.env.FUND_SOL_TOPUP || 0.05);

/**
 * Below this the vault stops funding wallets, so whatever SOL is left goes
 * to swap payouts and fees instead of being handed out.
 */
export const VAULT_SOL_FLOOR = Number(process.env.VAULT_SOL_FLOOR || 0.5);

async function assertVaultAboveFloor(vault: PublicKey, topUp: bigint) {
  const balance = BigInt(await devnetConnection.getBalance(vault));
  const floor = BigInt(Math.floor(VAULT_SOL_FLOOR * LAMPORTS_PER_SOL));

  if (balance - topUp >= floor) return;

  throw new Error(
    `Top-ups are paused: the vault holds ${fromBaseUnits(balance, 9)} SOL and keeps ` +
      `${VAULT_SOL_FLOOR} SOL in reserve so swaps can still settle. Airdrop devnet SOL ` +
      `to ${vault.toBase58()} (faucet.solana.com) to resume.`,
  );
}

/**
 * USD value of each project token a top-up mints. Sized by notional because
 * unit counts mean nothing across tokens (500 BONK is about a cent), and big
 * enough that one top-up covers a $200k demo trade.
 */
export const FUND_TOKEN_USD = Number(process.env.FUND_TOKEN_USD || 250_000);

const STABLECOINS = new Set(["USDC", "USDT"]);

/**
 * How many base units of `token` are worth `usd` at its mainnet price.
 * Stablecoins fall back to $1 when no price is available; anything else
 * refuses rather than guessing a size.
 */
export function unitsForUsd(token: TokenDetails, usd: number): bigint {
  const price = token.price && token.price > 0 ? token.price : STABLECOINS.has(token.name) ? 1 : 0;
  if (!(price > 0)) {
    throw new Error(
      `No mainnet price for ${token.name} right now, so the top-up cannot be sized. Try again in a minute.`,
    );
  }
  return toBaseUnits(usd / price, token.decimals);
}

/**
 * Tops a wallet up so it can trade: a little SOL from the vault, plus
 * FUND_TOKEN_USD worth of each project token minted fresh, all in one
 * transaction so the whole top-up is a single confirmation.
 *
 * `tokens` must carry mainnet prices (getSupportedTokens), which size the
 * mints.
 */
export async function fundWallet(
  owner: PublicKey,
  tokens: TokenDetails[],
): Promise<string[]> {
  const vault = loadVaultKeypair();
  const topUp = BigInt(Math.floor(FUND_SOL_TOPUP * LAMPORTS_PER_SOL));

  await assertVaultAboveFloor(vault.publicKey, topUp);
  await assertVaultCanPay(vault.publicKey, topUp, "a top-up");

  const instructions: TransactionInstruction[] = [
    SystemProgram.transfer({
      fromPubkey: vault.publicKey,
      toPubkey: owner,
      lamports: topUp,
    }),
  ];

  for (const token of tokens) {
    if (token.native) continue;

    const mint = requireDevnetMint(token);
    const ata = getAssociatedTokenAddressSync(mint, owner);

    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        vault.publicKey,
        ata,
        owner,
        mint,
      ),
      createMintToInstruction(
        mint,
        ata,
        vault.publicKey,
        unitsForUsd(token, FUND_TOKEN_USD),
      ),
    );
  }

  const signature = await sendAndConfirm(
    instructions,
    [vault],
    vault.publicKey,
  );

  return [signature];
}
/**
 * Moves one token out of a user wallet to any devnet address.
 *
 * The vault signs as fee payer, the same arrangement settleSwap uses, which
 * has two consequences worth knowing: a wallet with no SOL can still send its
 * tokens, and a SOL send can drain the balance to zero because nothing has to
 * be held back for the fee.
 *
 * Unlike a swap this is a single leg. Value leaves and does not come back, so
 * the caller is responsible for having checked the balance first.
 */
export async function sendTokens({
  senderKeypair,
  token,
  recipient,
  baseUnits,
}: {
  senderKeypair: Keypair;
  token: TokenDetails;
  recipient: PublicKey;
  baseUnits: bigint;
}): Promise<string> {
  const vault = loadVaultKeypair();
  const sender = senderKeypair.publicKey;

  // The vault funds no part of the amount here, only the fee and any token
  // account the recipient still needs, which is what the headroom covers.
  await assertVaultCanPay(vault.publicKey, BigInt(0), "sending");

  if (token.native) {
    return sendAndConfirm(
      [
        SystemProgram.transfer({
          fromPubkey: sender,
          toPubkey: recipient,
          lamports: baseUnits,
        }),
      ],
      [vault, senderKeypair],
      vault.publicKey,
    );
  }

  const mint = requireDevnetMint(token);
  const from = getAssociatedTokenAddressSync(mint, sender);
  const to = getAssociatedTokenAddressSync(mint, recipient);

  return sendAndConfirm(
    [
      // A recipient who has never held this mint has no token account yet.
      // Creating it idempotently at the vault's expense means sending to a
      // brand new address behaves the same as sending to a funded one.
      createAssociatedTokenAccountIdempotentInstruction(
        vault.publicKey,
        to,
        recipient,
        mint,
      ),
      createTransferCheckedInstruction(
        from,
        mint,
        to,
        sender,
        baseUnits,
        token.decimals,
      ),
    ],
    [vault, senderKeypair],
    vault.publicKey,
  );
}
