/**
 * How much the vault pays out for a quote, and whether that is allowed.
 *
 * The slippage cap is enforced here, against the server's own quote:
 *
 *   minOut = quotedOut × (1 − slippageBps / 10 000)
 *
 * A fill below minOut is never settled. In "exact" mode the vault pays the
 * quote and the bound always holds. A simulated mode (P2) reduces the payout
 * by a modelled shortfall, and that is what gives the cap something to do.
 *
 * All arithmetic is in base units with bigint. Both figures round up: minOut
 * so that "below the cap" is exact (Jupiter's otherAmountThreshold rounds the
 * same way), and the fill so that a fill exactly at the cap is not pushed
 * under it by rounding. Either way the user is favoured by under one base
 * unit.
 */

export type FillMode = "exact" | "simulated";

export type FillDecision = {
  mode: FillMode;
  /** What the vault would pay out, in output base units. */
  fillOut: bigint;
  /** How far below the quote the fill is, in bps. 0 for an exact fill. */
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

export function applyShortfall(quotedOut: bigint, shortfallBps: number): bigint {
  if (!Number.isFinite(shortfallBps) || shortfallBps < 0) {
    throw new Error(`Shortfall must be a non-negative number of bps, got ${shortfallBps}`);
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
