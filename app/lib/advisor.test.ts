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
  splitImpactBps,
  type AdvisorParams,
} from "./advisor";
import type { CostModel } from "./costModel";

const linear = (lo: number, hi: number) => Array.from({ length: 101 }, (_, k) => lo + ((hi - lo) * k) / 100);

/**
 * Hand-built markets, each shaped to make one mode the right answer. Test
 * fixtures with chosen parameters, not fitted to any data.
 *
 * Waiting drift = waitingCoefPerSqrtS * sqrt(T) + volCoef * vol * sqrt(T/60)
 * (identity standardisation). Short-horizon drift at +5 s is `drift`, or,
 * when byVol is given, a separate distribution per volatility tertile.
 */
function market({
  pair,
  impact,
  drift,
  waitingCoefPerSqrtS = 0.1,
  volCoef = 0,
  normalVol = 1,
  byVol,
}: {
  pair: string;
  impact: { a: number; b: number };
  drift: number[];
  waitingCoefPerSqrtS?: number;
  volCoef?: number;
  normalVol?: number;
  byVol?: { tertiles: [number, number]; low: number[]; mid: number[]; high: number[] };
}): CostModel {
  const cells: CostModel["shortHorizon"]["cells"] = { [`${pair}|5|all`]: { n: 500, q: drift } };
  if (byVol) {
    for (const b of ["low", "mid", "high"] as const) cells[`${pair}|5|${b}`] = { n: 200, q: byVol[b] };
  }
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
    features: [
      { name: "sqrt_horizon_s", derivation: "", mean: 0, std: 1 },
      { name: "vol_sigma_bps", derivation: "", mean: 0, std: 1 },
      { name: "thin_sqrt_horizon_s", derivation: "", mean: 0, std: 1 },
    ],
    impact: {
      model: "powerlaw",
      baselineNotionalUsd: 25,
      perPair: { [pair]: { ...impact, n: 500, notionalMinUsd: 5, notionalMaxUsd: 2_000_000 } },
      byDepth: {},
      cells: [],
    },
    drift: {
      target: "",
      model: "ridge",
      alpha: 1,
      intercept: 0,
      coef: [waitingCoefPerSqrtS, volCoef, 0],
      volFallbackByPair: { [pair]: normalVol },
      volFallbackByDepth: {},
      cells: [5, 15, 30, 60].map((h) => ({ pair, horizonSeconds: h, n: 500 })),
    },
    shortHorizon: { volTertiles: { [pair]: byVol ? byVol.tertiles : null }, cells },
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
// Calm normally, wild when volatility is high: the case DEFER exists for.
const REGIME = market({
  pair: "JUP/USDC",
  impact: { a: 0.5, b: 0.3 },
  drift: linear(-2, 2),
  volCoef: 1,
  normalVol: 1,
  byVol: { tertiles: [2, 5], low: linear(-2, 2), mid: linear(-4, 4), high: linear(-10, 40) },
});

const order = (pair: string, notionalUsd: number, capBps = 50, volatility: number | null = 2) => ({ pair, notionalUsd, capBps, volatility });

describe("advise: the mode each market calls for", () => {
  it("sends a tiny trade in a deep pool straight away", () => {
    expect(advise(DEEP, order("SOL/USDC", 100)).mode).toBe("SEND_NOW");
  });

  it("splits a large trade in a thin pool, and does not defer for structural cost", () => {
    const a = advise(THIN, order("BONK/USDC", 200_000));
    expect(a.mode).toBe("SPLIT");
    expect(a.best.cost.impactBps).toBeLessThan(a.byMode.SEND_NOW.cost.impactBps);
    expect(a.transient.elevated).toBe(false);
    expect(a.explanation).toMatch(/This cost is structural — waiting will not help/);
  });

  it("tightens and retries when short-horizon drift has a long adverse tail", () => {
    const a = advise(VOLATILE, order("WIF/USDC", 1_000));
    expect(a.mode).toBe("TIGHTEN_AND_RETRY");
    expect(a.best.cost.executionDriftBps).toBeLessThan(a.byMode.SEND_NOW.cost.executionDriftBps);
  });

  it("defers, when enabled, if the transient part is elevated against its own norm", () => {
    const a = advise(REGIME, order("JUP/USDC", 1_000, 50, 10), { ...DEFAULT_ADVISOR_PARAMS, deferEnabled: true });
    expect(a.mode).toBe("DEFER");
    expect(a.transient.elevated).toBe(true);
    expect(a.transient.nowBps).toBeGreaterThanOrEqual(2 * a.transient.normBps);
    expect(a.explanation).toMatch(/^DEFER: /);
  });

  it("does not defer the same order at normal volatility", () => {
    expect(advise(REGIME, order("JUP/USDC", 1_000, 50, 1), { ...DEFAULT_ADVISOR_PARAMS, deferEnabled: true }).mode).not.toBe("DEFER");
  });

  it("never defers by default, but still reports the transient test", () => {
    const a = advise(REGIME, order("JUP/USDC", 1_000, 50, 10));
    expect(DEFAULT_ADVISOR_PARAMS.deferEnabled).toBe(false);
    expect(a.mode).not.toBe("DEFER");
    expect(a.transient.elevated).toBe(true);
  });

  it("does not judge against a norm it cannot compute", () => {
    const a = advise(REGIME, order("JUP/USDC", 1_000, 50, null));
    expect(a.transient.elevated).toBe(false);
    expect(a.transient.note).toMatch(/volatility is unknown/);
  });
});

describe("advise: the willingness-to-pay check", () => {
  it("says a high cost is structural when it is, rather than deferring", () => {
    const params: AdvisorParams = { ...DEFAULT_ADVISOR_PARAMS, maxCostBps: 50 };
    const a = advise(THIN, order("BONK/USDC", 200_000), params);
    expect(a.mode).not.toBe("DEFER");
    expect(a.costCheck).toMatchObject({ maxCostBps: 50, exceeded: true });
    expect(a.costCheck!.message).toMatch(/this cost is structural — waiting will not help/);
    expect(a.structuralShare).toBeGreaterThan(0.8);
  });

  it("says waiting may help when the excess is mostly transient", () => {
    const params: AdvisorParams = { ...DEFAULT_ADVISOR_PARAMS, maxCostBps: 1 };
    const a = advise(VOLATILE, order("WIF/USDC", 1_000), params);
    expect(a.costCheck!.exceeded).toBe(true);
    expect(a.costCheck!.message).toMatch(/waiting may help/);
  });
});

describe("phi: what a failed fill loses", () => {
  it("is the fee plus one retry cycle's adverse drift, negligible on a large order", () => {
    const a = advise(THIN, order("BONK/USDC", 200_000));
    const c = a.byMode.SEND_NOW.cost;
    // Fee: $0.002 on $200k = 0.0001 bps. Retry drift: 0.1 * sqrt(5) + 0 (volCoef 0).
    expect(c.feeBps).toBeCloseTo(0.0001, 9);
    expect(c.failurePenaltyBps).toBeCloseTo(0.0001 + 0.1 * Math.sqrt(5), 9);
  });
});

describe("splitImpactBps: the recovery bracket", () => {
  const I = (x: number) => (x <= 25 ? 0 : 10 * (x / 1000)); // linear impact, 10 bps per $1k

  it("is impact at N/k under full recovery, rho = 1", () => {
    expect(splitImpactBps(I, 200_000, 8, 1)).toBeCloseTo(I(25_000), 9);
  });

  it("is impact at N under no recovery, rho = 0: splitting saves nothing", () => {
    expect(splitImpactBps(I, 200_000, 8, 0)).toBeCloseTo(I(200_000), 9);
  });

  it("falls monotonically as recovery rises", () => {
    const at = [0, 0.25, 0.5, 0.75, 1].map((rho) => splitImpactBps(I, 200_000, 8, rho));
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeLessThan(at[i - 1]);
  });

  it("refuses a recovery fraction outside [0, 1]", () => {
    expect(() => splitImpactBps(I, 1000, 2, 1.5)).toThrow();
  });

  it("drives the advisor: with no recovery there is no reason to split", () => {
    const a = advise(THIN, order("BONK/USDC", 200_000), { ...DEFAULT_ADVISOR_PARAMS, recoveryFraction: 0 });
    expect(a.mode).not.toBe("SPLIT");
    expect(a.recoveryFraction).toBe(0);
  });
});

describe("advise: counterfactuals", () => {
  it("prices every mode family, chosen or not, and every grid point", () => {
    const p = { ...DEFAULT_ADVISOR_PARAMS, minPortionIntervalSeconds: 0 };
    const a = advise(DEEP, order("SOL/USDC", 100), p);
    expect(Object.keys(a.byMode).sort()).toEqual(["SEND_NOW", "SPLIT", "TIGHTEN_AND_RETRY"]);
    expect(a.candidates).toHaveLength(1 + p.splitCounts.length * p.splitWindowsSeconds.length + p.tightenFractions.length * p.retryCounts.length);
    for (const c of a.candidates) {
      const { structuralBps, transientBps, impactBps, feeBps, totalBps } = c.cost;
      expect(structuralBps).toBeCloseTo(impactBps + feeBps, 9);
      expect(totalBps).toBeCloseTo(structuralBps + transientBps, 9);
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

  it("flags a best split that uses the most portions allowed", () => {
    const a = advise(THIN, order("BONK/USDC", 50_000));
    expect(a.byMode.SPLIT.params.k).toBe(24);
    expect(a.splitAtGridBoundary).toBe(true);
  });

  it("keeps portions at least minPortionIntervalSeconds apart", () => {
    const a = advise(THIN, order("BONK/USDC", 50_000), { ...DEFAULT_ADVISOR_PARAMS, minPortionIntervalSeconds: 20 });
    for (const c of a.candidates.filter((x) => x.mode === "SPLIT")) {
      expect(c.params.windowSeconds! / (c.params.k! - 1)).toBeGreaterThanOrEqual(20);
    }
    expect(a.candidates.some((c) => c.params.k === 24 && c.params.windowSeconds === 300)).toBe(false);
  });

  it("does not flag a split whose k is interior", () => {
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
    // D on [-10, 30]: E[max(0, D)] = integral of (-10 + 40u) over u in [0.25, 1] = 11.25.
    expect(partialPositiveMean(linear(-10, 30), 1)).toBeCloseTo(11.25, 9);
    expect(partialPositiveMean(linear(-10, 30), 0.25)).toBeCloseTo(0, 9);
  });

  it("gives the drift of fills that settle and the share that do not", () => {
    // Cap 10 on [-10, 30]: half settle, uniform on [-10, 10]: E[max(0, D) | settle] = 2.5.
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

  it("sends $100 of SOL now and does not send $200k of BONK as one order", () => {
    expect(advise(example, { pair: "SOL/USDC", notionalUsd: 100, capBps: 50, volatility: null }).mode).toBe("SEND_NOW");
    expect(advise(example, { pair: "BONK/USDC", notionalUsd: 200_000, capBps: 50, volatility: null }).mode).not.toBe("SEND_NOW");
  });
});
