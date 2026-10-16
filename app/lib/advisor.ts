/**
 * The execution-mode advisor. Pure and deterministic: given a cost model and
 * an order it prices every execution mode and picks the cheapest, with no
 * network, clock or randomness inside.
 *
 *   C(m) = I(m) + X(m) + p(m) * phi + fees(m)        all in bps of notional
 *
 *   I    price impact at the sizes actually sent (structural: depth)
 *   X    adverse drift: on each fill, bounded by the cap that fill was sent
 *        with, plus drift accrued while waiting between split portions or
 *        retries (transient: it moves with volatility)
 *   p    probability a fill does not settle because drift beat its cap
 *   phi  what a failed fill actually loses: its fee plus the expected adverse
 *        drift over one retry cycle. For a large order this is tiny ($0.002
 *        on $200k is 0.0001 bps); it does no work there, and should not be
 *        read as if it did.
 *
 * Modes:
 *   SEND_NOW                one order at full size
 *   SPLIT(k, W)             k portions of S/k, evenly over W seconds, each
 *                           with its own fresh quote and the user's cap
 *   TIGHTEN_AND_RETRY(c, R) full size with a tighter cap c, retried up to R
 *                           times if drift beats it
 *   DEFER                   when the TRANSIENT part of the cheapest plan is
 *                           elevated against its own norm. Waiting does not
 *                           fix depth, so structural cost never triggers it.
 *
 * Pool recovery between split portions is unmeasured (the sampler never
 * trades, so no recorded quote reflects our own fills). It is a parameter,
 * recoveryFraction rho: the share of the previous portions' displacement that
 * has decayed before the next portion lands. rho = 1 is full recovery (each
 * portion pays impact at its own size, the optimistic bound); rho = 0 is none
 * (the portions together pay exactly what one order would). See
 * splitImpactBps.
 *
 * Other assumptions: portions and retries see independent drift; a failed
 * attempt pays its fee, as a reverted transaction does on mainnet.
 */

import {
  depthOf,
  exceedance,
  predictDriftAdverse,
  predictImpact,
  resolvePair,
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
  /** Time to notice a failed fill and try again, seconds. Sets phi's drift term. */
  retryIntervalSeconds: number;
  /** Pool recovery between split portions, 0..1. Unmeasured: bracket it. */
  recoveryFraction: number;
  /** The shortest gap allowed between split portions, seconds. */
  minPortionIntervalSeconds: number;
  /** DEFER when transient cost is at least this multiple of its norm... */
  deferTransientRatio: number;
  /** ...and at least this many bps above it. */
  deferMinExcessBps: number;
  /** The pair's normal volatility; null uses the model's typical value for it. */
  normalVolatility: number | null;
  /** The user's willingness to pay, bps of notional; null for no check. */
  maxCostBps: number | null;
  /** Above this structural share of total cost, waiting is said not to help. */
  structuralShareForMessage: number;
  splitCounts: number[];
  splitWindowsSeconds: number[];
  /** Tighter caps as fractions of the user's cap. */
  tightenFractions: number[];
  retryCounts: number[];
};

export const DEFAULT_ADVISOR_PARAMS: AdvisorParams = {
  latencySeconds: 5,
  feeUsd: 0.002,
  retryIntervalSeconds: 5,
  recoveryFraction: 1,
  minPortionIntervalSeconds: 10,
  deferTransientRatio: 2,
  deferMinExcessBps: 1,
  normalVolatility: null,
  maxCostBps: null,
  structuralShareForMessage: 0.8,
  splitCounts: [2, 3, 4, 6, 8, 12, 16, 24],
  splitWindowsSeconds: [30, 60, 120, 300, 600, 900],
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
  /** Impact plus fees: depth, which waiting does not change. */
  structuralBps: number;
  /** Drift and failure: what moves with volatility, and what waiting can change. */
  transientBps: number;
  totalBps: number;
};

export type CandidateParams = { k?: number; windowSeconds?: number; capBps?: number; retries?: number };

export type Candidate = {
  mode: Exclude<Mode, "DEFER">;
  params: CandidateParams;
  cost: CostBreakdown;
  coverage: Coverage;
  lowConfidence: boolean;
};

export type Advice = {
  mode: Mode;
  /** The cheapest executable plan. When mode is DEFER, the plan being deferred. */
  best: Candidate;
  /** The cheapest configuration of every mode family, chosen or not. */
  byMode: Record<Exclude<Mode, "DEFER">, Candidate>;
  /** Every configuration evaluated, for the evaluation and the UI. */
  candidates: Candidate[];
  /** True when the best SPLIT uses the most portions allowed, so more might be cheaper still. */
  splitAtGridBoundary: boolean;
  /** The DEFER test, shown whether or not it fired. */
  transient: {
    nowBps: number;
    normBps: number;
    normalVolatility: number | null;
    elevated: boolean;
    note: string;
  };
  /** Share of the best plan's cost that is structural. */
  structuralShare: number;
  /** The willingness-to-pay check, when the user gave a maximum. */
  costCheck: { maxCostBps: number; exceeded: boolean; message: string } | null;
  explanation: string;
  recoveryFraction: number;
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

/**
 * Impact of k portions of N/k, as bps of N, under recovery rho.
 *
 * impactAt(x) is the average impact (bps) of sending x at once, so x * impactAt(x)
 * is its total cost. Before each portion the pool is still displaced by D,
 * the unrecovered part of everything sent so far; the portion pays the
 * incremental cost of pushing the pool from D to D + N/k. Afterwards a share
 * rho of the displacement decays:
 *
 *   cost_j = (D_j + N/k) I(D_j + N/k) - D_j I(D_j),   D_{j+1} = (1 - rho)(D_j + N/k)
 *
 * rho = 1 leaves D = 0, so each portion pays I(N/k): the full-recovery bound.
 * rho = 0 telescopes to N I(N): splitting saves nothing on impact.
 * The backtest uses this same function on recorded curves.
 */
export function splitImpactBps(impactAt: (usd: number) => number, notionalUsd: number, k: number, rho: number): number {
  if (!(rho >= 0 && rho <= 1)) throw new Error(`recovery fraction must be in [0, 1], got ${rho}`);
  const portion = notionalUsd / k;
  let displaced = 0;
  let cost = 0;
  for (let j = 0; j < k; j++) {
    const size = displaced + portion;
    cost += size * impactAt(size) - (displaced > 0 ? displaced * impactAt(displaced) : 0);
    displaced = (1 - rho) * size;
  }
  return cost / notionalUsd;
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

function breakdown(c: Omit<CostBreakdown, "structuralBps" | "transientBps" | "totalBps">): CostBreakdown {
  const structuralBps = c.impactBps + c.feeBps;
  const transientBps = c.executionDriftBps + c.waitingDriftBps + c.failureProbability * c.failurePenaltyBps;
  return { ...c, structuralBps, transientBps, totalBps: structuralBps + transientBps };
}

const sameParams = (a: CandidateParams, b: CandidateParams) =>
  a.k === b.k && a.windowSeconds === b.windowSeconds && a.capBps === b.capBps && a.retries === b.retries;

/** Every candidate plan, priced at one volatility. */
export function priceCandidates(
  model: CostModel,
  input: AdviceInput,
  params: AdvisorParams = DEFAULT_ADVISOR_PARAMS,
): Candidate[] {
  const { pair, notionalUsd, capBps, volatility } = input;
  if (!(notionalUsd > 0)) throw new Error("notionalUsd must be positive");

  const L = params.latencySeconds;
  const feeBps = (params.feeUsd / notionalUsd) * 10_000;
  const rho = params.recoveryFraction;

  const waiting = (seconds: number) =>
    seconds <= 0 ? { value: 0, coverage: "ok" as Coverage } : predictDriftAdverse(model, pair, seconds, volatility);
  const retry = waiting(params.retryIntervalSeconds);
  const phi = feeBps + retry.value;

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

  const impactAt = (usd: number) => predictImpact(model, pair, usd).value;
  const candidates: Candidate[] = [];
  const push = (mode: Candidate["mode"], p: CandidateParams, cost: CostBreakdown, coverage: Coverage) =>
    candidates.push({ mode, params: p, cost, coverage, lowConfidence: coverage !== "ok" });

  // SEND_NOW
  {
    const impact = predictImpact(model, pair, notionalUsd);
    const e = exec(capBps);
    push(
      "SEND_NOW",
      {},
      breakdown({ impactBps: impact.value, executionDriftBps: e.drift, waitingDriftBps: 0, failureProbability: e.failure, failurePenaltyBps: phi, feeBps }),
      worst(impact.coverage, e.coverage, retry.coverage),
    );
  }

  // SPLIT(k, W)
  for (const k of params.splitCounts) {
    if (k < 2) continue;
    const impactCoverage = worst(predictImpact(model, pair, notionalUsd / k).coverage, predictImpact(model, pair, notionalUsd).coverage);
    const impactBps = splitImpactBps(impactAt, notionalUsd, k, rho);
    const e = exec(capBps);
    for (const W of params.splitWindowsSeconds) {
      if (W / (k - 1) < params.minPortionIntervalSeconds) continue;
      const waits = portionDelays(k, W).map(waiting);
      push(
        "SPLIT",
        { k, windowSeconds: W },
        breakdown({
          impactBps,
          executionDriftBps: e.drift,
          waitingDriftBps: waits.reduce((s, w) => s + w.value, 0) / k,
          failureProbability: e.failure,
          failurePenaltyBps: phi,
          feeBps: k * feeBps,
        }),
        worst(impactCoverage, e.coverage, retry.coverage, ...waits.map((w) => w.coverage)),
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
          breakdown({
            impactBps: impact.value,
            executionDriftBps: e.drift,
            waitingDriftBps: (attempts - 1) * retryWait.value,
            failureProbability: Math.pow(pFail, R),
            failurePenaltyBps: phi,
            feeBps: attempts * feeBps,
          }),
          worst(impact.coverage, e.coverage, retryWait.coverage, retry.coverage),
        );
      }
    }
  }

  return candidates;
}

function cheapestOf(candidates: Candidate[], mode: Candidate["mode"]): Candidate {
  const of = candidates.filter((c) => c.mode === mode);
  if (!of.length) throw new Error(`no ${mode} configuration is allowed by the advisor parameters`);
  return of.reduce((a, b) => (b.cost.totalBps < a.cost.totalBps ? b : a));
}

/** The pair's normal volatility: the caller's, else the model's typical value for the pair or its depth class. */
export function normalVolatilityFor(model: CostModel, pair: string, override: number | null): number | null {
  if (override !== null) return override;
  const { source } = resolvePair(model, pair);
  return (source ? model.drift.volFallbackByPair[source] : undefined) ?? model.drift.volFallbackByDepth[depthOf(pair)] ?? null;
}

export function advise(model: CostModel, input: AdviceInput, params: AdvisorParams = DEFAULT_ADVISOR_PARAMS): Advice {
  const candidates = priceCandidates(model, input, params);

  const byMode = {
    SEND_NOW: cheapestOf(candidates, "SEND_NOW"),
    SPLIT: cheapestOf(candidates, "SPLIT"),
    TIGHTEN_AND_RETRY: cheapestOf(candidates, "TIGHTEN_AND_RETRY"),
  };
  const best = Object.values(byMode).reduce((a, b) => (b.cost.totalBps < a.cost.totalBps ? b : a));

  // Waiting drift only grows with W, so the best window for any k is always
  // the shortest the interval rule allows; W at its minimum is structural.
  // The edge that matters is k: if the most portions allowed is cheapest,
  // more might be cheaper still.
  const maxK = Math.max(...candidates.filter((c) => c.mode === "SPLIT").map((c) => c.params.k!));
  const splitAtGridBoundary = byMode.SPLIT.params.k === maxK;

  // DEFER: is the transient part of this plan elevated against its own norm?
  const normalVolatility = normalVolatilityFor(model, input.pair, params.normalVolatility);
  let transient: Advice["transient"];
  if (input.volatility === null || normalVolatility === null) {
    transient = {
      nowBps: best.cost.transientBps,
      normBps: best.cost.transientBps,
      normalVolatility,
      elevated: false,
      note: "current volatility is unknown, so transient cost cannot be judged against its norm; not deferring",
    };
  } else {
    const atNorm = priceCandidates(model, { ...input, volatility: normalVolatility }, params).find(
      (c) => c.mode === best.mode && sameParams(c.params, best.params),
    )!;
    const now = best.cost.transientBps;
    const norm = atNorm.cost.transientBps;
    const elevated = now >= params.deferTransientRatio * norm && now - norm >= params.deferMinExcessBps;
    transient = {
      nowBps: now,
      normBps: norm,
      normalVolatility,
      elevated,
      note: elevated
        ? `transient cost is ${now.toFixed(2)} bps against a norm of ${norm.toFixed(2)} bps at normal volatility; waiting is expected to help`
        : `transient cost ${now.toFixed(2)} bps is within its norm (${norm.toFixed(2)} bps at normal volatility)`,
    };
  }

  const structuralShare = best.cost.totalBps > 0 ? best.cost.structuralBps / best.cost.totalBps : 1;
  const structural = structuralShare >= params.structuralShareForMessage;

  const costCheck =
    params.maxCostBps === null
      ? null
      : {
          maxCostBps: params.maxCostBps,
          exceeded: best.cost.totalBps > params.maxCostBps,
          message:
            best.cost.totalBps <= params.maxCostBps
              ? `within your maximum of ${params.maxCostBps} bps`
              : structural
                ? `this costs ${best.cost.totalBps.toFixed(1)} bps, over your maximum of ${params.maxCostBps} bps, and ${(100 * structuralShare).toFixed(0)}% of it is structural: this cost is structural — waiting will not help.`
                : `this costs ${best.cost.totalBps.toFixed(1)} bps, over your maximum of ${params.maxCostBps} bps; most of it is transient, so waiting may help.`,
        };

  const explanation = transient.elevated
    ? `DEFER: ${transient.note}.`
    : structural
      ? `${best.mode}: ${(100 * structuralShare).toFixed(0)}% of the predicted ${best.cost.totalBps.toFixed(1)} bps is impact and fees. This cost is structural — waiting will not help.`
      : `${best.mode}: predicted ${best.cost.totalBps.toFixed(1)} bps, ${(100 * structuralShare).toFixed(0)}% structural.`;

  return {
    mode: transient.elevated ? "DEFER" : best.mode,
    best,
    byMode,
    candidates,
    splitAtGridBoundary,
    transient,
    structuralShare,
    costCheck,
    explanation,
    recoveryFraction: params.recoveryFraction,
    modelVersion: model.modelVersion,
    lowConfidence: best.lowConfidence,
  };
}
