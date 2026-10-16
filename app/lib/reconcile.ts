/**
 * Resolves swaps left Pending with a signature: broadcast, but the server
 * stopped waiting before it heard back (see SettlementUncertainError).
 *
 * Runs when the settlement log loads, a few rows at a time, so a timed-out
 * swap does not sit in the log as "pending" forever.
 *
 *   confirmed on chain        -> Settled, delivered amount read from the
 *                                transaction's own balance changes
 *   failed on chain           -> Failed, with the chain's error
 *   unknown 5 min after sign  -> Failed: its blockhash expired long ago, so
 *                                it can no longer land
 *   anything else             -> left Pending for the next pass
 */

import type { Connection, ParsedTransactionWithMeta } from "@solana/web3.js";
import { tokenByMint } from "./constants";
import { fromBaseUnits } from "./devnet";

export const RECONCILE_BATCH = 25;

/** Well past any blockhash's validity (about 60-90 s on devnet). */
export const NEVER_LANDED_AFTER_MS = 5 * 60_000;

export type PendingSwap = {
  id: string;
  signature: string;
  signedAt: Date | null;
  createdAt: Date;
  outputMint: string | null;
  walletPublicKey: string | null;
};

/** What the owner's balance of `mint` changed by in a transaction, in base units. */
export function deliveredBaseUnits(
  tx: ParsedTransactionWithMeta,
  owner: string,
  outputMint: string,
  native: boolean,
): bigint | null {
  const meta = tx.meta;
  if (!meta) return null;

  if (native) {
    const index = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === owner);
    if (index < 0) return null;
    return BigInt(meta.postBalances[index]) - BigInt(meta.preBalances[index]);
  }

  const amount = (list: typeof meta.postTokenBalances) =>
    BigInt(list?.find((b) => b.owner === owner && b.mint === outputMint)?.uiTokenAmount.amount ?? "0");
  return amount(meta.postTokenBalances) - amount(meta.preTokenBalances);
}

export type Resolution =
  | { id: string; status: "Settled"; settledOut: number | null }
  | { id: string; status: "Failed"; failureReason: string }
  | { id: string; status: "Pending" };

export async function reconcilePending(
  rows: PendingSwap[],
  connection: Pick<Connection, "getSignatureStatuses" | "getParsedTransaction">,
  now = Date.now(),
): Promise<Resolution[]> {
  if (!rows.length) return [];

  const { value } = await connection.getSignatureStatuses(
    rows.map((r) => r.signature),
    { searchTransactionHistory: true },
  );

  const out: Resolution[] = [];
  for (const [i, row] of rows.entries()) {
    const status = value[i];

    if (status?.err) {
      out.push({ id: row.id, status: "Failed", failureReason: `Failed on chain: ${JSON.stringify(status.err)}` });
      continue;
    }

    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      let settledOut: number | null = null;
      const token = row.outputMint ? tokenByMint(row.outputMint) : undefined;
      if (token && row.walletPublicKey) {
        try {
          const tx = await connection.getParsedTransaction(row.signature, { maxSupportedTransactionVersion: 0 });
          const delta = tx
            ? deliveredBaseUnits(tx, row.walletPublicKey, token.native ? token.mint : token.devnetMint, token.native)
            : null;
          if (delta !== null && delta >= BigInt(0)) settledOut = fromBaseUnits(delta, token.decimals);
        } catch {
          // Settled either way; the amount just could not be read back.
        }
      }
      out.push({ id: row.id, status: "Settled", settledOut });
      continue;
    }

    const signedAt = (row.signedAt ?? row.createdAt).getTime();
    if (!status && now - signedAt > NEVER_LANDED_AFTER_MS) {
      out.push({
        id: row.id,
        status: "Failed",
        failureReason: "Never landed: devnet has no record of it and its blockhash has expired.",
      });
      continue;
    }

    out.push({ id: row.id, status: "Pending" });
  }

  return out;
}
