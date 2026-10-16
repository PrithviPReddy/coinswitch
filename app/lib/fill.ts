/**
 * How much the vault pays out for a quote, and whether that is allowed.
 *
 * The slippage cap is enforced here, against the server's own quote:
 *
 *   minOut = quotedOut × (1 − slippageBps / 10 000)
 *
 * A fill below minOut is never settled. In "exact" mode the vault pays the
 * quote and the bound always holds. In "simulated" mode the payout moves by
 * a shortfall drawn from recorded mainnet quote drift (see fillModel.ts).
 * The draw is two-sided: a negative shortfall pays out more than quoted, as
 * real execution sometimes does. A simulated fill is a modelled payout on
 * devnet, not observed slippage.
 *
 * All arithmetic is in base units with bigint. Both figures round up: minOut
 * so that "below the cap" is exact (Jupiter's otherAmountThreshold rounds the
 * same way), and the fill so that a fill exactly at the cap is not pushed
 * under it by rounding. Either way the user is favoured by under one base
 * unit.
 */

import {
  nearestHorizon,
  quantileAt,
  resolveBucket,
  type BucketLevel,
  type FillArtifact,
} from "./fillModel";

export type FillMode = "exact" | "simulated";

export type FillDecision = {
  mode: FillMode;
  /** What the vault would pay out, in output base units. */
  fillOut: bigint;
  /** How far below the quote the fill is, in bps; negative pays above it. 0 when exact. */
  shortfallBps: number;
  /** Identifies the model that produced a simulated fill. Null when exact. */
  modelVersion: string | null;
  /** The lowest output the user's slippage cap accepts. */
  minOut: bigint;
  withinBound: boolean;
};

const BPS = BigInt(10_000);

// Shortfall is applied in millionths of a basis point so a fractional bps
// figure is not rounded away before it reaches the payout.
const MICRO = BigInt(1_000_000);

const ONE = BigInt(1);

function divCeil(a: bigint, b: bigint): bigint {
  return (a + b - ONE) / b;
}

export function minOutFor(quotedOut: bigint, slippageBps: number): bigint {
  return divCeil(quotedOut * (BPS - BigInt(slippageBps)), BPS);
}

/**
 * The quote moved by `shortfallBps`: positive pays less, negative pays more.
 * Anything at or beyond ±100% is refused rather than paying nothing or double.
 */
export function applyShortfall(quotedOut: bigint, shortfallBps: number): bigint {
  if (!Number.isFinite(shortfallBps) || Math.abs(shortfallBps) >= 10_000) {
    throw new Error(`Shortfall must be strictly between -10000 and 10000 bps, got ${shortfallBps}`);
  }
  const micro = BigInt(Math.round(shortfallBps * 1_000_000));
  return divCeil(quotedOut * (BPS * MICRO - micro), BPS * MICRO);
}

export function decideFill({
  quotedOut,
  slippageBps,
  mode = "exact",
  shortfallBps = 0,
  modelVersion = null,
}: {
  quotedOut: bigint;
  slippageBps: number;
  mode?: FillMode;
  shortfallBps?: number;
  modelVersion?: string | null;
}): FillDecision {
  const effectiveShortfall = mode === "exact" ? 0 : shortfallBps;
  const fillOut = applyShortfall(quotedOut, effectiveShortfall);
  const minOut = minOutFor(quotedOut, slippageBps);

  return {
    mode,
    fillOut,
    shortfallBps: effectiveShortfall,
    modelVersion: mode === "exact" ? null : modelVersion,
    minOut,
    withinBound: fillOut >= minOut,
  };
}

/** Which distribution a simulated fill was drawn from. Stored on the Swap row. */
export type FillAudit = {
  modelVersion: string | null;
  bucketLevel: BucketLevel | "none";
  bucketKey: string | null;
  bucketN: number | null;
  horizonSeconds: number | null;
  latencyEstimateMs: number | null;
  volatility: number | null;
  /** Why the fill fell back to exact, when it did. */
  fallbackReason: string | null;
};

export type SimulatedFillInput = {
  artifact: FillArtifact | null;
  quotedOut: bigint;
  slippageBps: number;
  inputSymbol: string;
  outputSymbol: string;
  notionalUsd: number | null;
  volatility: number | null;
  latencyEstimateMs: number;
  /** Uniform in [0, 1). Passed in so a decision can be reproduced in tests. */
  u: number;
};

/**
 * A simulated fill: the drift horizon nearest the latency estimate, the most
 * specific bucket with enough data for this swap, and one draw from it.
 *
 * With no artifact, or no bucket at all for this horizon and depth class, it
 * falls back to an exact fill and says why. It never invents a distribution.
 */
export function simulatedFill(input: SimulatedFillInput): { decision: FillDecision; audit: FillAudit } {
  const exact = (fallbackReason: string, partial: Partial<FillAudit> = {}) => ({
    decision: decideFill({ quotedOut: input.quotedOut, slippageBps: input.slippageBps, mode: "exact" }),
    audit: {
      modelVersion: null,
      bucketLevel: "none" as const,
      bucketKey: null,
      bucketN: null,
      horizonSeconds: null,
      latencyEstimateMs: input.latencyEstimateMs,
      volatility: input.volatility,
      fallbackReason,
      ...partial,
    },
  });

  if (!input.artifact) return exact("no fill model artifact is loaded");

  const horizonSeconds = nearestHorizon(input.latencyEstimateMs);
  const bucket = resolveBucket(input.artifact, {
    inputSymbol: input.inputSymbol,
    outputSymbol: input.outputSymbol,
    notionalUsd: input.notionalUsd,
    volatility: input.volatility,
    horizonSeconds,
  });

  if (!bucket) {
    return exact(`the artifact has no bucket for +${horizonSeconds}s at this depth`, { horizonSeconds });
  }

  const shortfallBps = Math.round(quantileAt(bucket.q, input.u) * 1e6) / 1e6;

  return {
    decision: decideFill({
      quotedOut: input.quotedOut,
      slippageBps: input.slippageBps,
      mode: "simulated",
      shortfallBps,
      modelVersion: input.artifact.version,
    }),
    audit: {
      modelVersion: input.artifact.version,
      bucketLevel: bucket.level,
      bucketKey: bucket.key,
      bucketN: bucket.n,
      horizonSeconds,
      latencyEstimateMs: input.latencyEstimateMs,
      volatility: input.volatility,
      fallbackReason: null,
    },
  };
}
