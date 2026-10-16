/**
 * One swap, end to end: the server quotes it, decides the fill, records it,
 * settles it on devnet and reads the result back.
 *
 * The request carries only what the user chose: wallet, pair, size and
 * slippage cap. Any quote a client sends is not read, so a forged outAmount
 * cannot reach the vault, and a quote left over from a previous pair cannot
 * settle the wrong trade.
 *
 * Dependencies are passed in so the whole sequence can be exercised against
 * fakes; the route supplies the real ones.
 */

import type { Keypair, PublicKey } from "@solana/web3.js";
import { DEFAULT_SLIPPAGE_BPS, explorerTxUrl, tokenByMint, type TokenDetails } from "./constants";
import type { FillDecision } from "./fill";
import type { Quote } from "./jupiter";
import { QuoteError } from "./jupiter";
import {
  SettlementNotAppliedError,
  SettlementUncertainError,
  fromBaseUnits,
  type SendHooks,
} from "./devnet";

/** Wider than any sane trade needs; a typo of 5000 is refused, not honoured. */
export const MAX_SLIPPAGE_BPS = 1_000;

export const SLIPPAGE_BOUND_REASON = "slippage bound exceeded";

export function parseSlippageBps(raw: unknown): number | null {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_SLIPPAGE_BPS
    ? value
    : null;
}

export type SwapRequest = {
  walletId?: string;
  inputToken: TokenDetails;
  outputToken: TokenDetails;
  inAmountBaseUnits: bigint;
  slippageBps: number;
};

/**
 * Reads exactly five fields and nothing else. Whatever else the body holds,
 * a quoteResponse included, is dropped here.
 */
export function parseSwapRequest(
  body: unknown,
): { ok: true; request: SwapRequest } | { ok: false; message: string } {
  const b = (body ?? {}) as Record<string, unknown>;

  const inputToken = typeof b.inputMint === "string" ? tokenByMint(b.inputMint) : undefined;
  const outputToken = typeof b.outputMint === "string" ? tokenByMint(b.outputMint) : undefined;

  if (!inputToken || !outputToken) {
    return { ok: false, message: "Pair is not in the supported token list" };
  }
  if (inputToken.mint === outputToken.mint) {
    return { ok: false, message: "Pick two different tokens" };
  }

  const amount = b.inAmountBaseUnits;
  if (typeof amount !== "string" || !/^\d+$/.test(amount) || BigInt(amount) === BigInt(0)) {
    return { ok: false, message: "inAmountBaseUnits must be a positive integer string" };
  }

  const slippageBps =
    b.slippageBps === undefined ? DEFAULT_SLIPPAGE_BPS : parseSlippageBps(b.slippageBps);
  if (slippageBps === null) {
    return { ok: false, message: `slippageBps must be an integer from 1 to ${MAX_SLIPPAGE_BPS}` };
  }

  if (b.walletId !== undefined && typeof b.walletId !== "string") {
    return { ok: false, message: "walletId must be a string" };
  }

  return {
    ok: true,
    request: {
      walletId: b.walletId as string | undefined,
      inputToken,
      outputToken,
      inAmountBaseUnits: BigInt(amount),
      slippageBps,
    },
  };
}

/** The subset of the Swap table this flow writes. */
export type SwapStore = {
  create(data: Record<string, unknown>): Promise<{ id: string }>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
};

export type SwapDeps = {
  fetchQuote(args: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<Quote>;
  decideFill(args: { quote: Quote; slippageBps: number }): FillDecision;
  readBalance(token: TokenDetails, owner: PublicKey): Promise<bigint>;
  settleSwap(
    args: {
      userKeypair: Keypair;
      inputToken: TokenDetails;
      outputToken: TokenDetails;
      inBaseUnits: bigint;
      outBaseUnits: bigint;
    } & SendHooks,
  ): Promise<string>;
  swaps: SwapStore;
};

export type SwapResult = { status: number; body: Record<string, unknown> };

export async function executeSwap(
  deps: SwapDeps,
  {
    userId,
    wallet,
    owner,
    userKeypair,
    request,
  }: {
    userId: string;
    wallet: { id: string };
    owner: PublicKey;
    userKeypair: Keypair;
    request: SwapRequest;
  },
): Promise<SwapResult> {
  const { inputToken, outputToken, slippageBps } = request;

  let quote: Quote;
  try {
    quote = await deps.fetchQuote({
      inputMint: inputToken.mint,
      outputMint: outputToken.mint,
      amount: request.inAmountBaseUnits,
      slippageBps,
    });
  } catch (error) {
    const message = error instanceof QuoteError ? error.message : "Could not fetch a quote.";
    return { status: 502, body: { message } };
  }

  const fill = deps.decideFill({ quote, slippageBps });

  const inAmount = fromBaseUnits(quote.inAmount, inputToken.decimals);
  const quotedOut = fromBaseUnits(quote.outAmount, outputToken.decimals);

  // Written before anything is signed, so a swap that dies mid-flight still
  // leaves evidence rather than vanishing.
  const swap = await deps.swaps.create({
    userId,
    walletId: wallet.id,
    inputSymbol: inputToken.name,
    outputSymbol: outputToken.name,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount,
    quotedOut,
    priceImpactPct: quote.priceImpactPct,
    slippageBps,
    routeLabels: quote.routeLabels,
    quotedAt: quote.quotedAt,
    quoteLatencyMs: quote.latencyMs,
    contextSlot: quote.contextSlot,
    otherAmountThreshold: quote.otherAmountThreshold.toString(),
  });

  const common = {
    id: swap.id,
    inAmount,
    quotedOut,
    inputSymbol: inputToken.name,
    outputSymbol: outputToken.name,
    routeLabels: quote.routeLabels,
    fillMode: fill.mode,
  };

  if (!fill.withinBound) {
    await deps.swaps.update(swap.id, { status: "Failed", failureReason: SLIPPAGE_BOUND_REASON });

    const fillOut = fromBaseUnits(fill.fillOut, outputToken.decimals);
    const minOut = fromBaseUnits(fill.minOut, outputToken.decimals);
    return {
      status: 409,
      body: {
        ...common,
        status: "Failed",
        message:
          `Not settled: ${SLIPPAGE_BOUND_REASON}. The fill would deliver ${fillOut} ` +
          `${outputToken.name}, below the ${minOut} your ${slippageBps} bps cap allows.`,
      },
    };
  }

  let signature: string | null = null;
  let confirmed = false;

  try {
    const balanceBefore = await deps.readBalance(outputToken, owner);

    await deps.settleSwap({
      userKeypair,
      inputToken,
      outputToken,
      inBaseUnits: quote.inAmount,
      outBaseUnits: fill.fillOut,
      // Persisted before broadcast: whatever happens next, the row points at
      // the transaction.
      onSigned: async (sig) => {
        signature = sig;
        await deps.swaps.update(swap.id, { signature: sig });
      },
    });
    confirmed = true;

    // Read back from devnet rather than copied from the fill.
    const balanceAfter = await deps.readBalance(outputToken, owner);
    const settledOut = fromBaseUnits(
      balanceAfter > balanceBefore ? balanceAfter - balanceBefore : BigInt(0),
      outputToken.decimals,
    );

    await deps.swaps.update(swap.id, { status: "Settled", settledOut });

    return {
      status: 200,
      body: {
        ...common,
        status: "Settled",
        signature,
        explorerUrl: explorerTxUrl(signature!),
        settledOut,
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Settlement failed on devnet";

    // It confirmed, and only the read-back failed: the swap happened.
    if (confirmed) {
      await deps.swaps.update(swap.id, { status: "Settled", settledOut: null });
      return {
        status: 200,
        body: {
          ...common,
          status: "Settled",
          signature,
          explorerUrl: explorerTxUrl(signature!),
          settledOut: null,
          message: "Settled, but the delivered amount could not be read back from devnet.",
        },
      };
    }

    // Signed and possibly broadcast, outcome unknown: Pending, never Failed.
    if (signature && !(error instanceof SettlementNotAppliedError)) {
      const pendingSignature = error instanceof SettlementUncertainError ? error.signature : signature;
      return {
        status: 202,
        body: {
          ...common,
          status: "Pending",
          signature: pendingSignature,
          explorerUrl: explorerTxUrl(pendingSignature),
          message: reason,
        },
      };
    }

    // Known not to have applied, or nothing was ever signed.
    await deps.swaps.update(swap.id, { status: "Failed", failureReason: reason.slice(0, 500) });
    return {
      status: 502,
      body: { ...common, status: "Failed", signature, message: reason },
    };
  }
}
