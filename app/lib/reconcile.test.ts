import { describe, expect, it } from "vitest";
import { NEVER_LANDED_AFTER_MS, reconcilePending, type PendingSwap } from "./reconcile";

const SOL = "So11111111111111111111111111111111111111112";
const OWNER = "2AMa3ZLLgkFg1Z4qr44v8NouMH7PajoaWVJNaJhUPW2e";
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

const row = (id: string, signedAgoMs: number): PendingSwap => ({
  id,
  signature: `sig-${id}`,
  signedAt: new Date(NOW - signedAgoMs),
  createdAt: new Date(NOW - signedAgoMs),
  outputMint: SOL,
  walletPublicKey: OWNER,
});

/** A connection that answers from fixed statuses and one SOL-delivering transaction. */
function fakeConnection(statuses: unknown[]) {
  return {
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: statuses }),
    getParsedTransaction: async () => ({
      meta: { preBalances: [0, 1_000_000_000], postBalances: [0, 1_009_384_000], preTokenBalances: [], postTokenBalances: [] },
      transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => "vault" } }, { pubkey: { toBase58: () => OWNER } }] } },
    }),
  } as never;
}

describe("reconcilePending", () => {
  it("settles a confirmed transaction with the amount it actually delivered", async () => {
    const [r] = await reconcilePending([row("a", 60_000)], fakeConnection([{ confirmationStatus: "finalized", err: null }]), NOW);
    expect(r).toEqual({ id: "a", status: "Settled", settledOut: 0.009384 });
  });

  it("fails one the chain rejected", async () => {
    const [r] = await reconcilePending([row("b", 60_000)], fakeConnection([{ confirmationStatus: "confirmed", err: { InstructionError: [1, "Custom"] } }]), NOW);
    expect(r).toMatchObject({ id: "b", status: "Failed" });
  });

  it("fails one devnet has never heard of, once its blockhash must have expired", async () => {
    const [r] = await reconcilePending([row("c", NEVER_LANDED_AFTER_MS + 1)], fakeConnection([null]), NOW);
    expect(r).toMatchObject({ id: "c", status: "Failed" });
  });

  it("leaves a recent unknown one Pending: it may still land", async () => {
    const [r] = await reconcilePending([row("d", 30_000)], fakeConnection([null]), NOW);
    expect(r).toEqual({ id: "d", status: "Pending" });
  });
});
