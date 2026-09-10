import { Keypair } from "@solana/web3.js";
import db from "@/app/db";

/**
 * Wallets are created here and nowhere else. Sign-in and the create button in
 * the terminal both come through this file, so there is exactly one place
 * where a keypair is generated and one definition of what a new wallet looks
 * like.
 *
 * There is deliberately no import path. Keys are custodial and generated
 * server side, which is the whole reason the server can sign a settlement
 * without a browser wallet. Accepting a key from outside would mean holding a
 * secret this project did not create, and the README's "worthless devnet
 * keys" caveat would stop being true.
 */

/**
 * A cap exists because funding is free to the user and not free to the vault:
 * every wallet can call /api/fund, and each call sends devnet SOL plus 500 of
 * each project token out of a vault topped up by a rate-limited faucet.
 */
export const MAX_WALLETS_PER_USER = Number(
  process.env.MAX_WALLETS_PER_USER ?? 5,
);

/** Public shape. privateKey is never in it, so it cannot leak by accident. */
export type WalletSummary = {
  id: string;
  label: string;
  publicKey: string;
  createdAt: string;
};

export function toWalletSummary(wallet: {
  id: string;
  label: string;
  publicKey: string;
  createdAt: Date;
}): WalletSummary {
  return {
    id: wallet.id,
    label: wallet.label,
    publicKey: wallet.publicKey,
    createdAt: wallet.createdAt.toISOString(),
  };
}

/**
 * Numbers continue from the highest "Wallet N" already on the account rather
 * than from the wallet count, so renaming one does not cause the next create
 * to reuse a number that is still on screen.
 */
function nextLabel(existingLabels: string[]): string {
  const highest = existingLabels.reduce((max, label) => {
    const match = /^Wallet (\d+)$/.exec(label);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

  return `Wallet ${Math.max(highest, existingLabels.length) + 1}`;
}

export class WalletLimitError extends Error {
  constructor(limit: number) {
    super(
      `This account already has ${limit} wallets, which is the limit. Use one of the existing wallets.`,
    );
  }
}

/**
 * Generates a devnet keypair and stores it against the user. Returns the full
 * row; callers that hand it to a client are responsible for narrowing it with
 * toWalletSummary first.
 */
export async function createWalletForUser(userId: string) {
  const existing = await db.solWallet.findMany({
    where: { userId },
    select: { label: true },
  });

  if (existing.length >= MAX_WALLETS_PER_USER) {
    throw new WalletLimitError(MAX_WALLETS_PER_USER);
  }

  const keypair = Keypair.generate();

  return db.solWallet.create({
    data: {
      userId,
      label: nextLabel(existing.map((w) => w.label)),
      publicKey: keypair.publicKey.toBase58(),
      privateKey: keypair.secretKey.toString(),
    },
  });
}

/**
 * Resolves the wallet a request is talking about, scoped to the signed-in
 * user. The userId in the where clause is the authorisation check: a walletId
 * belonging to somebody else matches nothing and comes back null, which reads
 * to the caller exactly like a wallet that does not exist.
 *
 * A missing walletId falls back to the account's oldest wallet, so a client
 * that has not chosen one yet still lands somewhere sensible.
 */
export async function resolveWallet(userId: string, walletId?: string | null) {
  if (walletId) {
    return db.solWallet.findFirst({ where: { id: walletId, userId } });
  }

  return db.solWallet.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
}

export async function listWallets(userId: string) {
  const wallets = await db.solWallet.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, label: true, publicKey: true, createdAt: true },
  });

  return wallets.map(toWalletSummary);
}
