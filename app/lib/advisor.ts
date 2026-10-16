/**
 * The execution-mode advisor. Pure and deterministic: given a cost model and
 * an order it prices every execution mode and picks the cheapest, with no
 * network, clock or randomness inside.
 *
 *   C(m) = I(m) + X(m) + p(m) * phi + fees(m)        all in bps of notional
 *
 *   I  price impact: impact curve at the size actually sent
 *   X  adverse drift: execution drift on each fill, bounded by the cap that
 *      fill was sent with, plus drift accrued while waiting (between split
 *      portions, or between retries)
 *   p  probability a fill does not settle because drift beat its cap
 *   phi the cost assigned to a fill that does not settle (default: the cap)
 *
 * Modes:
 *   SEND_NOW                one order at full size
 *   SPLIT(k, W)             k portions of S/k, evenly over W seconds, each
 *                           with its own fresh quote and the user's cap
 *   TIGHTEN_AND_RETRY(c, R) full size with a tighter cap c, retried up to R
 *                           times if drift beats it
 *   DEFER                   chosen when even the cheapest mode costs more than
 *                           the user's threshold
 *
 * Assumptions, stated so the backtest can test them rather than inherit
 * them:
 *   - A pool recovers fully between split portions, given at least
 *     minPortionIntervalSeconds: each portion pays impact at its own size.
 *     Recovery was never measured (the sampler never trades, so no quote
 *     reflects our own fills), which makes SPLIT's predicted saving an upper
 *     bound.
 *   - Portions and retries see independent drift.
 *   - A failed attempt still pays its fee, as a reverted transaction does on
 *     mainnet.
 */

import {

  exceedance,
  predictDriftAdverse,
  predictImpact,
  shortHorizonDistribution,
  type CostModel,
  type Coverage,
} from "./costModel";

export type Mode = "SEND_NOW" | "SPLIT" | "TIGHTEN_AND_RETRY" | "DEFER";

export type AdvisorParams = {
  /** Quote-to-confirmation latency of one fill, seconds (measured ~3.5-4.4 s on devnet). */
  latencySeconds: number;
  /** Network fee per transaction, USD. An assumption, not measured here. */
  feeUsd: number;
  /** Cost of a fill that does not settle, bps. Null means "the user's cap". */
  failurePenaltyBps: number | null;
  /** Above this cheapest cost the advice is DEFER, bps. */
  deferThresholdBps: number;
  splitCounts: number[];
  splitWindowsSeconds: number[];
  /**
   * The shortest gap allowed between split portions, seconds. An assumption
   * standing in for unmeasured pool recovery; without it the shortest window
   * always wins, because waiting only ever adds drift.
   */
  minPortionIntervalSeconds: number;
  /** Tighter caps as fractions of the user's cap. */
  tightenFractions: number[];
  retryCounts: number[];
};

export const DEFAULT_ADVISOR_PARAMS: AdvisorParams = {
  latencySeconds: 5,
  feeUsd: 0.002,
  failurePenaltyBps: null,
  deferThresholdBps: 100,
  splitCounts: [2, 3, 4, 6, 8, 12, 16, 24],
  splitWindowsSeconds: [30, 60, 120, 300, 600, 900],
  minPortionIntervalSeconds: 10,
  tightenFractions: [0.25, 0.5, 0.75],
  retryCounts: [2, 3],
};

export type AdviceInput = {
  pair: string;
  notionalUsd: number;
  /** The user's slippage cap, bps. */
  capBps: number;
  /** Current realised volatility of the pair, or null if unknown. */
  volatility: number | null;
};

export type CostBreakdown = {
  impactBps: number;
  executionDriftBps: number;
  waitingDriftBps: number;
  failureProbability: number;
  failurePenaltyBps: number;
  feeBps: number;
  totalBps: number;
};

export type Candidate = {
  mode: Exclude<Mode, "DEFER">;
  params: { k?: number; windowSeconds?: number; capBps?: number; retries?: number };
  cost: CostBreakdown;
  coverage: Coverage;
  lowConfidence: boolean;
};

export type Advice = {
  mode: Mode;
  /** The cheapest executable mode. When mode is DEFER, what it would have been. */
  best: Candidate;
  /** The cheapest configuration of every mode family, chosen or not. */
  byMode: Record<Exclude<Mode, "DEFER">, Candidate>;
  /** Every configuration evaluated, for the evaluation and the UI. */
  candidates: Candidate[];
  /** True when the best SPLIT uses the most portions allowed, so more might be cheaper still. */
  splitAtGridBoundary: boolean;
  deferred: { thresholdBps: number; reason: string } | null;
  modelVersion: string;
  lowConfidence: boolean;
};

const RANK: Record<Coverage, number> = { ok: 0, sparse: 1, fallback: 2, extrapolated: 3, none: 4 };
export const worst = (...cs: Coverage[]): Coverage => cs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");

/**
 * The integral of max(0, q(u)) over u in [0, uMax], with q the stored
 * quantile function (piecewise linear between the 101 points). Exact.
 */
export function partialPositiveMean(q: number[], uMax: number): number {
  const last = q.length - 1;
  let total = 0;
  for (let k = 0; k < last; k++) {
    const u0 = k / last;
    if (u0 >= uMax) break;
    const u1 = Math.min((k + 1) / last, uMax);
    const slope = (q[k + 1] - q[k]) * last;
    const a = q[k];
    const b = a + slope * (u1 - u0);
    if (a >= 0 && b >= 0) total += ((a + b) / 2) * (u1 - u0);
    else if (a > 0 || b > 0) {
      // The segment crosses zero: integrate only the positive part.
      const cross = u0 + -a / slope;
      total += a > 0 ? (a / 2) * (cross - u0) : (b / 2) * (u1 - cross);
    }
  }
  return total;
}

/** E[max(0, D) | D <= cap], and P(D > cap), from a stored distribution. */
export function boundedExecution(q: number[], capBps: number): { drift: number; failure: number } {
  const failure = exceedance(q, capBps);
  const settle = 1 - failure;
  return { drift: settle > 0 ? partialPositiveMean(q, settle) / settle : 0, failure };
}

/** Splits a base-unit amount into k parts that sum exactly, the remainder spread over the first parts. */
export function splitBaseUnits(total: bigint, k: number): bigint[] {
  if (!Number.isInteger(k) || k < 1) throw new Error(`k must be a positive integer, got ${k}`);
  if (total < BigInt(k)) throw new Error(`cannot split ${total} base units into ${k} non-empty parts`);
  const K = BigInt(k);
  const base = total / K;
  const remainder = Number(total % K);
  return Array.from({ length: k }, (_, i) => base + (i < remainder ? BigInt(1) : BigInt(0)));
}

/** Delay of portion j of k spread evenly over W seconds: 0, W/(k-1), ..., W. */
export function portionDelays(k: number, windowSeconds: number): number[] {
  return Array.from({ length: k }, (_, j) => (k === 1 ? 0 : (j * windowSeconds) / (k - 1)));
}

function total(c: Omit<CostBreakdown, "totalBps">): CostBreakdown {
  return {
    ...c,
    totalBps: c.impactBps + c.executionDriftBps + c.waitingDriftBps + c.failureProbability * c.failurePenaltyBps + c.feeBps,
  };
}

export function advise(model: CostModel, input: AdviceInput, params: AdvisorParams = DEFAULT_ADVISOR_PARAMS): Advice {
  const { pair, notionalUsd, capBps, volatility } = input;
  if (!(notionalUsd > 0)) throw new Error("notionalUsd must be positive");

  const phi = params.failurePenaltyBps ?? capBps;
  const L = params.latencySeconds;
  const feeBps = (params.feeUsd / notionalUsd) * 10_000;

  // The short-horizon drift distribution at execution latency, shared by all modes.
  const dist = shortHorizonDistribution(model, pair, L, volatility);
  const exec = (cap: number) => {
    if (!dist) {
      // No distribution at all: fall back to the drift model, with no failure term.
      const d = predictDriftAdverse(model, pair, L, volatility);
      return { drift: d.value, failure: 0, coverage: "none" as Coverage };
    }
    return { ...boundedExecution(dist.q, cap), coverage: dist.coverage };
  };
  const waiting = (seconds: number) =>
    seconds <= 0 ? { value: 0, coverage: "ok" as Coverage } : predictDriftAdverse(model, pair, seconds, volatility);

  const candidates: Candidate[] = [];
  const push = (mode: Candidate["mode"], p: Candidate["params"], cost: CostBreakdown, coverage: Coverage) =>
    candidates.push({ mode, params: p, cost, coverage, lowConfidence: coverage !== "ok" });

  // SEND_NOW
  {
    const impact = predictImpact(model, pair, notionalUsd);
    const e = exec(capBps);
    push(
      "SEND_NOW",
      {},
      total({ impactBps: impact.value, executionDriftBps: e.drift, waitingDriftBps: 0, failureProbability: e.failure, failurePenaltyBps: phi, feeBps }),
      worst(impact.coverage, e.coverage),
    );
  }

  // SPLIT(k, W)
  for (const k of params.splitCounts) {
    if (k < 2) continue;
    const impact = predictImpact(model, pair, notionalUsd / k);
    const e = exec(capBps);
    for (const W of params.splitWindowsSeconds) {
      if (W / (k - 1) < params.minPortionIntervalSeconds) continue;
      const waits = portionDelays(k, W).map(waiting);
      push(
        "SPLIT",
        { k, windowSeconds: W },
        total({
          impactBps: impact.value,
          executionDriftBps: e.drift,
          waitingDriftBps: waits.reduce((s, w) => s + w.value, 0) / k,
          failureProbability: e.failure,
          failurePenaltyBps: phi,
          feeBps: k * feeBps,
        }),
        worst(impact.coverage, e.coverage, ...waits.map((w) => w.coverage)),
      );
    }
  }

  // TIGHTEN_AND_RETRY(c, R)
  {
    const impact = predictImpact(model, pair, notionalUsd);
    const retryWait = waiting(L);
    for (const fraction of params.tightenFractions) {
      const cap = capBps * fraction;
      const e = exec(cap);
      for (const R of params.retryCounts) {
        const pFail = e.failure;
        const attempts = pFail >= 1 ? R : (1 - Math.pow(pFail, R)) / (1 - pFail);
        push(
          "TIGHTEN_AND_RETRY",
          { capBps: cap, retries: R },
          total({
            impactBps: impact.value,
            executionDriftBps: e.drift,
            waitingDriftBps: (attempts - 1) * retryWait.value,
            failureProbability: Math.pow(pFail, R),
            failurePenaltyBps: phi,
            feeBps: attempts * feeBps,
          }),
          worst(impact.coverage, e.coverage, retryWait.coverage),
        );
      }
    }
  }

  const cheapest = (mode: Candidate["mode"]) => {
    const of = candidates.filter((c) => c.mode === mode);
    if (!of.length) throw new Error(`no ${mode} configuration is allowed by the advisor parameters`);
    return of.reduce((a, b) => (b.cost.totalBps < a.cost.totalBps ? b : a));
  };

  const byMode = {
    SEND_NOW: cheapest("SEND_NOW"),
    SPLIT: cheapest("SPLIT"),
    TIGHTEN_AND_RETRY: cheapest("TIGHTEN_AND_RETRY"),
  };
  const best = Object.values(byMode).reduce((a, b) => (b.cost.totalBps < a.cost.totalBps ? b : a));

  // Waiting drift only grows with W, so the best window for any k is always
  // the shortest the interval rule allows; W sitting at its minimum is
  // structural, not a sign the optimum lies off the grid. The edge that
  // matters is k: if the most portions allowed is the cheapest, more might
  // be cheaper still.
  const maxK = Math.max(...candidates.filter((c) => c.mode === "SPLIT").map((c) => c.params.k!));
  const splitAtGridBoundary = byMode.SPLIT.params.k === maxK;

  const deferred =
    best.cost.totalBps > params.deferThresholdBps
      ? {
          thresholdBps: params.deferThresholdBps,
          reason: `the cheapest mode (${best.mode}) is predicted to cost ${best.cost.totalBps.toFixed(1)} bps, above the ${params.deferThresholdBps} bps threshold`,
        }
      : null;

  return {
    mode: deferred ? "DEFER" : best.mode,
    best,
    byMode,
    candidates,
    splitAtGridBoundary,
    deferred,
    modelVersion: model.modelVersion,
    lowConfidence: best.lowConfidence,
  };
}
