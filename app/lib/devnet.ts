import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { devnetConnection, TokenDetails } from "./constants";

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
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const { value } = await devnetConnection.getSignatureStatuses([signature]);
    const status = value[0];

    if (status?.err) {
      throw new Error(
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
      throw new Error(
        `Transaction ${signature} expired before confirming. It was not applied.`,
      );
    }

    await sleep(1000);
  }

  throw new Error(
    `Timed out waiting for ${signature}. Check it on Solscan before retrying.`,
  );
}

/** Sends a set of instructions and waits for confirmation over HTTP. */
async function sendAndConfirm(
  instructions: TransactionInstruction[],
  signers: Keypair[],
  feePayer: PublicKey,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await devnetConnection.getLatestBlockhash("confirmed");

  const transaction = new Transaction({
    feePayer,
    blockhash,
    lastValidBlockHeight,
  }).add(...instructions);

  transaction.sign(...signers);

  const signature = await devnetConnection.sendRawTransaction(
    transaction.serialize(),
    { maxRetries: 3 },
  );

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

  const ata = getAssociatedTokenAddressSync(
    new PublicKey(token.devnetMint),
    owner,
  );

  try {
    const account = await getAccount(devnetConnection, ata);
    return account.amount;
  } catch {
    return BigInt(0);
  }
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
}: {
  userKeypair: Keypair;
  inputToken: TokenDetails;
  outputToken: TokenDetails;
  inBaseUnits: bigint;
  outBaseUnits: bigint;
}): Promise<string> {
  const vault = loadVaultKeypair();
  const user = userKeypair.publicKey;

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
    const mint = new PublicKey(inputToken.devnetMint);
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
    const mint = new PublicKey(outputToken.devnetMint);
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

  return sendAndConfirm(instructions, [vault, userKeypair], vault.publicKey);
}

/**
 * Tops a wallet up so it can trade: SOL from the vault plus a fixed allowance
 * of each project mint, all in one transaction so the whole top-up is a single
 * confirmation rather than one per token.
 */
export async function fundWallet(
  owner: PublicKey,
  tokens: TokenDetails[],
): Promise<string[]> {
  const vault = loadVaultKeypair();

  const instructions: TransactionInstruction[] = [
    SystemProgram.transfer({
      fromPubkey: vault.publicKey,
      toPubkey: owner,
      lamports: Math.floor(0.2 * LAMPORTS_PER_SOL),
    }),
  ];

  for (const token of tokens) {
    if (token.native) continue;

    if (!token.devnetMint) {
      throw new Error(
        `No devnet mint configured for ${token.name}. Check DEVNET_USDC_MINT ` +
          "and DEVNET_USDT_MINT, then recreate the app container.",
      );
    }

    const mint = new PublicKey(token.devnetMint);
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
        toBaseUnits(500, token.decimals),
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

  if (!token.devnetMint) {
    throw new Error(
      `No devnet mint configured for ${token.name}. Check DEVNET_USDC_MINT ` +
        "and DEVNET_USDT_MINT, then recreate the app container.",
    );
  }

  const mint = new PublicKey(token.devnetMint);
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
