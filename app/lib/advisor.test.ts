import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ADVISOR_PARAMS,
  advise,
  boundedExecution,
  partialPositiveMean,
  portionDelays,
  splitBaseUnits,
  type AdvisorParams,
} from "./advisor";
import type { CostModel } from "./costModel";

const linear = (lo: number, hi: number) => Array.from({ length: 101 }, (_, k) => lo + ((hi - lo) * k) / 100);

/**
 * Hand-built markets, each shaped to make one mode the right answer. These
 * are test fixtures with chosen parameters, not fitted to any data.
 */
function market({
  pair,
  impact,
  drift,
  waitingCoefPerSqrtS = 0.1,
}: {
  pair: string;
  impact: { a: number; b: number };
  drift: number[];
  waitingCoefPerSqrtS?: number;
}): CostModel {
  return {
    kind: "coinswitch-cost-model",
    schemaVersion: 1,
    modelVersion: `fixture-${pair}`,
    producer: "test fixture",
    trainedAt: "2026-10-16T12:00:00Z",
    datasetRowCounts: { quoteSamples: 0, quoteDrift: 0 },
    datasetTimeRange: { from: "", to: "" },
    split: { method: "time", cutoff: "", trainRows: { impact: 0, drift: 0 }, testRows: { impact: 0, drift: 0 } },
    pairs: { [pair]: pair.includes("BONK") || pair.includes("WIF") ? "thin" : "deep" },
    constants: { baselineRung: 1, impactFloorBps: 0.5, maxLadderSpanSeconds: 30, measuredHorizons: [5, 15, 30, 60], minCellN: 20, minConfidentN: 30, quantilePoints: 101 },
    volatility: { windowMinutes: 30, rung: 1, minReturns: 8, maxGapSeconds: 600, unit: "bps per sqrt(minute)" },
    // Waiting drift = coef * sqrt(T): raw features, identity standardisation.
    features: [
      { name: "sqrt_horizon_s", derivation: "", mean: 0, std: 1 },
      { name: "vol_sigma_bps", derivation: "", mean: 0, std: 1 },
      { name: "thin_sqrt_horizon_s", derivation: "", mean: 0, std: 1 },
    ],
    impact: {
      model: "powerlaw",
      baselineNotionalUsd: 25,
      perPair: { [pair]: { ...impact, n: 500, notionalMinUsd: 25, notionalMaxUsd: 2_000_000 } },
      byDepth: {},
      cells: [],
    },
    drift: {
      target: "",
      model: "ridge",
      alpha: 1,
      intercept: 0,
      coef: [waitingCoefPerSqrtS, 0, 0],
      volFallbackByPair: { [pair]: 1 },
      volFallbackByDepth: {},
      cells: [5, 15, 30, 60].map((h) => ({ pair, horizonSeconds: h, n: 500 })),
    },
    shortHorizon: { volTertiles: { [pair]: null }, cells: { [`${pair}|5|all`]: { n: 500, q: drift } } },
    metrics: {},
    reports: { driftCoverage: [], impactTable: [], directionalTest: [] },
    limitations: ["fixture"],
    selfTestVectors: [],
    featureTestVectors: [],
  };
}

// Deep and calm: tiny impact, drift within +-2 bps.
const DEEP = market({ pair: "SOL/USDC", impact: { a: 0.7, b: 0.2 }, drift: linear(-2, 2) });
// Thin: impact roughly linear in size, ~2,000 bps at $200k.
const THIN = market({ pair: "BONK/USDC", impact: { a: 10, b: 1 }, drift: linear(-4, 4) });
// Volatile: modest impact, a long adverse tail in short-horizon drift.
const VOLATILE = market({ pair: "WIF/USDC", impact: { a: 0.5, b: 0.3 }, drift: linear(-5, 45) });

const order = (pair: string, notionalUsd: number, capBps = 50) => ({ pair, notionalUsd, capBps, volatility: 2 });

describe("advise: the mode each market calls for", () => {
  it("sends a tiny trade in a deep pool straight away", () => {
    const a = advise(DEEP, order("SOL/USDC", 100));
    expect(a.mode).toBe("SEND_NOW");
    expect(a.deferred).toBeNull();
  });

  it("splits a large trade in a thin pool", () => {
    const a = advise(THIN, order("BONK/USDC", 5_000), { ...DEFAULT_ADVISOR_PARAMS, deferThresholdBps: 10_000 });
    expect(a.mode).toBe("SPLIT");
    expect(a.best.cost.impactBps).toBeLessThan(a.byMode.SEND_NOW.cost.impactBps);
  });

  it("tightens and retries when short-horizon drift has a long adverse tail", () => {
    const a = advise(VOLATILE, order("WIF/USDC", 1_000), { ...DEFAULT_ADVISOR_PARAMS, failurePenaltyBps: 5 });
    expect(a.mode).toBe("TIGHTEN_AND_RETRY");
    expect(a.best.cost.executionDriftBps).toBeLessThan(a.byMode.SEND_NOW.cost.executionDriftBps);
  });

  it("defers when even the cheapest mode costs more than the threshold, and says what it would have done", () => {
    const a = advise(THIN, order("BONK/USDC", 200_000), { ...DEFAULT_ADVISOR_PARAMS, deferThresholdBps: 50 });
    expect(a.mode).toBe("DEFER");
    expect(a.deferred?.reason).toMatch(/above the 50 bps threshold/);
    expect(a.best.cost.totalBps).toBeGreaterThan(50);
  });
});

describe("advise: counterfactuals", () => {
  it("prices every mode family, chosen or not, and every grid point", () => {
    const p = { ...DEFAULT_ADVISOR_PARAMS, minPortionIntervalSeconds: 0 };
    const a = advise(DEEP, order("SOL/USDC", 100), p);
    expect(Object.keys(a.byMode).sort()).toEqual(["SEND_NOW", "SPLIT", "TIGHTEN_AND_RETRY"]);
    expect(a.candidates).toHaveLength(1 + p.splitCounts.length * p.splitWindowsSeconds.length + p.tightenFractions.length * p.retryCounts.length);
    for (const c of a.candidates) {
      const { impactBps, executionDriftBps, waitingDriftBps, failureProbability, failurePenaltyBps, feeBps, totalBps } = c.cost;
      expect(totalBps).toBeCloseTo(impactBps + executionDriftBps + waitingDriftBps + failureProbability * failurePenaltyBps + feeBps, 9);
    }
  });

  it("is deterministic: the same order always gets the same advice", () => {
    expect(advise(THIN, order("BONK/USDC", 5_000))).toEqual(advise(THIN, order("BONK/USDC", 5_000)));
  });
});

describe("advise: the k/W grid", () => {
  it("never proposes a split of one portion", () => {
    const params: AdvisorParams = { ...DEFAULT_ADVISOR_PARAMS, splitCounts: [1, 2, 4] };
    const a = advise(THIN, order("BONK/USDC", 5_000), params);
    expect(a.candidates.filter((c) => c.mode === "SPLIT").every((c) => (c.params.k ?? 0) >= 2)).toBe(true);
  });

  it("flags a best split on the edge of the grid, where the true optimum may lie outside it", () => {
    // Impact so steep that more portions always help: the best k is the largest offered.
    const a = advise(THIN, order("BONK/USDC", 50_000), { ...DEFAULT_ADVISOR_PARAMS, deferThresholdBps: 1e9 });
    expect(a.byMode.SPLIT.params.k).toBe(24);
    expect(a.splitAtGridBoundary).toBe(true);
  });

  it("keeps portions at least minPortionIntervalSeconds apart", () => {
    const a = advise(THIN, order("BONK/USDC", 50_000), { ...DEFAULT_ADVISOR_PARAMS, minPortionIntervalSeconds: 20 });
    for (const c of a.candidates.filter((x) => x.mode === "SPLIT")) {
      expect(c.params.windowSeconds! / (c.params.k! - 1)).toBeGreaterThanOrEqual(20);
    }
    // 24 portions 20 s apart need 460 s: the 30-300 s windows are not allowed for k = 24.
    expect(a.candidates.some((c) => c.params.k === 24 && c.params.windowSeconds === 300)).toBe(false);
  });

  it("does not flag a split whose k and window are both interior", () => {
    // Gentle convexity: a few portions help, many do not, so the optimum is inside the grid.
    const gentle = market({ pair: "BONK/USDC", impact: { a: 2, b: 1.2 }, drift: linear(-2, 2), waitingCoefPerSqrtS: 0.05 });
    const a = advise(gentle, order("BONK/USDC", 3_000), {
      ...DEFAULT_ADVISOR_PARAMS,
      feeUsd: 0.3,
      minPortionIntervalSeconds: 0,
      splitWindowsSeconds: [10, 30, 60],
    });
    expect(a.byMode.SPLIT.params.k).toBeGreaterThan(2);
    expect(a.byMode.SPLIT.params.k).toBeLessThan(24);
    expect(a.splitAtGridBoundary).toBe(false);
  });

  it("spreads portions evenly over the window, the first at once", () => {
    expect(portionDelays(4, 300)).toEqual([0, 100, 200, 300]);
    expect(portionDelays(2, 30)).toEqual([0, 30]);
  });
});

describe("splitBaseUnits", () => {
  it("splits exactly, spreading the remainder over the first portions", () => {
    const parts = splitBaseUnits(BigInt("6443002802551680"), 3);
    expect(parts.reduce((a, b) => a + b, BigInt(0))).toBe(BigInt("6443002802551680"));
    expect(parts).toEqual([BigInt("2147667600850560"), BigInt("2147667600850560"), BigInt("2147667600850560")]);
    expect(splitBaseUnits(BigInt(10), 3)).toEqual([BigInt(4), BigInt(3), BigInt(3)]);
  });

  it("refuses splits that cannot be made", () => {
    expect(() => splitBaseUnits(BigInt(2), 3)).toThrow();
    expect(() => splitBaseUnits(BigInt(10), 0)).toThrow();
  });
});

describe("bounded execution maths", () => {
  it("integrates the positive part of the quantile function exactly", () => {
    // D uniform-ish on [-10, 30]: E[max(0, D)] = integral of (-10 + 40u) over u in [0.25, 1] = 11.25.
    expect(partialPositiveMean(linear(-10, 30), 1)).toBeCloseTo(11.25, 9);
    expect(partialPositiveMean(linear(-10, 30), 0.25)).toBeCloseTo(0, 9);
  });

  it("gives the drift of fills that settle and the share that do not", () => {
    // Cap 10 on [-10, 30]: half settle; among them D is uniform on [-10, 10], so E[max(0, D) | settle] = 2.5.
    const { drift, failure } = boundedExecution(linear(-10, 30), 10);
    expect(failure).toBeCloseTo(0.5, 9);
    expect(drift).toBeCloseTo(2.5, 9);
  });
});

describe("advise against the committed example artifact", () => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, "../../models/cost-model.example.json"), "utf8")) as CostModel;

  it("runs for deep, thin, reversed and unsampled pairs, and reports coverage", () => {
    for (const [pair, usd] of [["SOL/USDC", 100], ["BONK/USDC", 200_000], ["USDC/BONK", 1_000], ["SOL/BONK", 50_000]] as const) {
      const a = advise(example, { pair, notionalUsd: usd, capBps: 50, volatility: null });
      expect(["SEND_NOW", "SPLIT", "TIGHTEN_AND_RETRY", "DEFER"]).toContain(a.mode);
      expect(Number.isFinite(a.best.cost.totalBps)).toBe(true);
      expect(typeof a.lowConfidence).toBe("boolean");
    }
  });

  it("sends a $100 SOL trade now and does not send $200k of BONK as one order", () => {
    expect(advise(example, { pair: "SOL/USDC", notionalUsd: 100, capBps: 50, volatility: null }).mode).toBe("SEND_NOW");
    expect(advise(example, { pair: "BONK/USDC", notionalUsd: 200_000, capBps: 50, volatility: null }).mode).not.toBe("SEND_NOW");
  });
});
