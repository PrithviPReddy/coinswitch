import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  exceedance,
  isLowConfidence,
  negateQuantiles,
  predict,
  predictDriftAdverse,
  predictFailure,
  predictImpact,
  resolvePair,
  segmentProblems,
  validateCostModel,
  type CostModel,
} from "./costModel";
import { validateJson } from "./jsonSchema";

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "../../models/cost-model.schema.json"), "utf8"));

const linear = (lo: number, hi: number) => Array.from({ length: 101 }, (_, k) => lo + ((hi - lo) * k) / 100);

/** A hand-built model: parameters chosen to make each rule easy to check, not fitted to anything. */
function fixture(): CostModel {
  return {
    kind: "coinswitch-cost-model",
    schemaVersion: 1,
    modelVersion: "unit-test",
    producer: "test fixture",
    trainedAt: "2026-10-16T12:00:00Z",
    datasetRowCounts: { quoteSamples: 0, quoteDrift: 0 },
    datasetTimeRange: { from: "2026-10-16T00:00:00Z", to: "2026-10-16T12:00:00Z" },
    split: { method: "time", cutoff: "2026-10-16T08:00:00Z", trainRows: { impact: 0, drift: 0 }, testRows: { impact: 0, drift: 0 } },
    pairs: { "BONK/USDC": "thin", "SOL/USDC": "deep" },
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
      perPair: { "BONK/USDC": { a: 10, b: 1, n: 100, notionalMinUsd: 100, notionalMaxUsd: 1_000_000 } },
      byDepth: { deep: { a: 1, b: 0.5, n: 10, notionalMinUsd: 100, notionalMaxUsd: 1_000_000 } },
      cells: [],
    },
    drift: {
      target: "",
      model: "ridge",
      alpha: 1,
      intercept: 0,
      coef: [1, 0, 0], // adverse drift = sqrt(T)
      volFallbackByPair: { "BONK/USDC": 4 },
      volFallbackByDepth: { deep: 1, thin: 4 },
      cells: [{ pair: "BONK/USDC", horizonSeconds: 5, n: 50 }, { pair: "SOL/USDC", horizonSeconds: 5, n: 10 }],
    },
    shortHorizon: {
      volTertiles: { "BONK/USDC": null, "SOL/USDC": null },
      cells: {
        "BONK/USDC|5|all": { n: 50, q: linear(-10, 30) },
        "thin|5|all": { n: 80, q: linear(-20, 20) },
        "SOL/USDC|5|all": { n: 25, q: linear(-2, 2) },
      },
    },
    metrics: { impact: { powerLaw: { thin: { n: 1, mae: 0, rmse: 0 } } } },
    reports: { driftCoverage: [], impactTable: [], directionalTest: [] },
    limitations: ["test"],
    selfTestVectors: [],
    featureTestVectors: [],
  };
}

describe("resolvePair", () => {
  const m = fixture();
  it("finds the pair, its reverse, or nothing", () => {
    expect(resolvePair(m, "BONK/USDC")).toEqual({ source: "BONK/USDC", reversed: false });
    expect(resolvePair(m, "USDC/BONK")).toEqual({ source: "BONK/USDC", reversed: true });
    expect(resolvePair(m, "SOL/BONK")).toEqual({ source: null, reversed: false });
  });
});

describe("predictImpact", () => {
  const m = fixture();
  it("is a (N/1000)^b above the baseline, 0 at or below it", () => {
    expect(predictImpact(m, "BONK/USDC", 10_000)).toEqual({ value: 100, coverage: "ok" });
    expect(predictImpact(m, "BONK/USDC", 25).value).toBe(0);
  });
  it("flags borrowed, extrapolated and sparse parameters", () => {
    expect(predictImpact(m, "USDC/BONK", 10_000).coverage).toBe("fallback"); // reversed
    expect(predictImpact(m, "SOL/USDC", 10_000).coverage).toBe("fallback"); // depth-level
    expect(predictImpact(m, "BONK/USDC", 5_000_000).coverage).toBe("extrapolated");
    const sparse = fixture();
    sparse.impact.perPair["BONK/USDC"].n = 5;
    expect(predictImpact(sparse, "BONK/USDC", 10_000).coverage).toBe("sparse");
  });
});

describe("predictImpact with a piecewise power law", () => {
  // 10 (N/1000)^1 up to $100k, then steeper: 1 (N/1000)^1.5, which meets it at $100k (1,000 bps).
  const piecewise = () => {
    const m = fixture();
    m.impact.perPair["BONK/USDC"].segments = [
      { fromUsd: 0, a: 10, b: 1, n: 100 },
      { fromUsd: 100_000, a: 1, b: 1.5, n: 40 },
    ];
    return m;
  };

  it("prices each size on its own segment, continuously across the breakpoint", () => {
    const m = piecewise();
    expect(predictImpact(m, "BONK/USDC", 10_000).value).toBeCloseTo(100, 9);
    expect(predictImpact(m, "BONK/USDC", 400_000).value).toBeCloseTo(8_000, 6);
    expect(predictImpact(m, "BONK/USDC", 100_000).value).toBeCloseTo(1_000, 9);
    expect(predictImpact(m, "BONK/USDC", 99_999).value).toBeCloseTo(999.99, 2);
    expect(predictImpact(m, "BONK/USDC", 25).value).toBe(0);
  });

  it("ignores the single-line (a, b) when segments are present", () => {
    const m = piecewise();
    m.impact.perPair["BONK/USDC"].a = 999;
    expect(predictImpact(m, "BONK/USDC", 10_000).value).toBeCloseTo(100, 9);
  });

  it("calls a prediction sparse when its own segment is thin", () => {
    const m = piecewise();
    m.impact.perPair["BONK/USDC"].segments![1].n = 10;
    expect(predictImpact(m, "BONK/USDC", 10_000).coverage).toBe("ok");
    expect(predictImpact(m, "BONK/USDC", 400_000).coverage).toBe("sparse");
  });

  it("accepts continuous segments and rejects broken ones", () => {
    const m = piecewise();
    expect(segmentProblems("x", m.impact.perPair["BONK/USDC"])).toEqual([]);

    const jump = piecewise();
    jump.impact.perPair["BONK/USDC"].segments![1].a = 1.1;
    expect(segmentProblems("x", jump.impact.perPair["BONK/USDC"]).join()).toMatch(/must be continuous/);

    const late = piecewise();
    late.impact.perPair["BONK/USDC"].segments![0].fromUsd = 25;
    expect(segmentProblems("x", late.impact.perPair["BONK/USDC"]).join()).toMatch(/fromUsd must be 0/);

    const order = piecewise();
    order.impact.perPair["BONK/USDC"].segments!.reverse();
    expect(segmentProblems("x", order.impact.perPair["BONK/USDC"]).join()).toMatch(/must be 0|ascending/);
  });
});

describe("predictDriftAdverse", () => {
  const m = fixture();
  it("evaluates the ridge on standardised features, floored at 0", () => {
    // T = 4 s: nearest measured horizon is 5 s, whose cell has n = 50.
    expect(predictDriftAdverse(m, "BONK/USDC", 4, 3)).toEqual({ value: 2, coverage: "ok" });
    const negative = fixture();
    negative.drift.intercept = -100;
    expect(predictDriftAdverse(negative, "BONK/USDC", 4, 3).value).toBe(0);
  });
  it("calls a horizon sparse when its nearest measured cell is missing", () => {
    // 25 s is nearest 30 s, and the fixture has no 30 s cell.
    expect(predictDriftAdverse(m, "BONK/USDC", 25, 3).coverage).toBe("sparse");
  });
  it("says when it extrapolates, borrows volatility, or sits in a thin cell", () => {
    expect(predictDriftAdverse(m, "BONK/USDC", 300, 3).coverage).toBe("extrapolated");
    expect(predictDriftAdverse(m, "BONK/USDC", 5, null).coverage).toBe("fallback");
    expect(predictDriftAdverse(m, "SOL/USDC", 5, 1).coverage).toBe("sparse"); // n = 10
  });
});

describe("exceedance", () => {
  const q = linear(0, 100);
  it("inverts the stored quantile function", () => {
    expect(exceedance(q, -1)).toBe(1);
    expect(exceedance(q, 100)).toBe(0);
    expect(exceedance(q, 25)).toBeCloseTo(0.75, 12);
    expect(exceedance(q, 25.5)).toBeCloseTo(0.745, 12);
  });
  it("handles flat stretches", () => {
    // q is 0 up to u = 0.49 and 5 at u = 0.50, so P(D > 0) = 1 - 0.49.
    const flat = [...Array(50).fill(0), ...linear(0, 10).slice(50)];
    expect(exceedance(flat, 0)).toBeCloseTo(0.51, 12);
  });
});

describe("predictFailure", () => {
  const m = fixture();
  it("reads P(D > cap) from the pair's cell", () => {
    // Uniform-ish on [-10, 30]: P(D > 10) = 0.5.
    expect(predictFailure(m, "BONK/USDC", 5, 10, null)).toEqual({ value: expect.closeTo(0.5, 12), coverage: "ok" });
  });
  it("flips the sign for the reverse direction and marks it", () => {
    // Reversed: [-30, 10]. P(D > 0) = 0.25.
    const r = predictFailure(m, "USDC/BONK", 5, 0, null);
    expect(r.value).toBeCloseTo(0.25, 12);
    expect(r.coverage).toBe("fallback");
  });
  it("falls back to the depth class, and admits when there is nothing", () => {
    expect(predictFailure(m, "SOL/BONK", 5, 0, null).coverage).toBe("fallback");
    expect(predictFailure(m, "SOL/BONK", 15, 0, null)).toEqual({ value: null, coverage: "none" });
    expect(predictFailure(m, "SOL/USDC", 5, 0, null).coverage).toBe("sparse"); // n = 25
  });
});

describe("negateQuantiles", () => {
  it("reflects the distribution", () => {
    expect(negateQuantiles(linear(-10, 30))[0]).toBe(-30);
  });
});

describe("validateCostModel", () => {
  const withVectors = () => {
    const m = fixture();
    m.selfTestVectors = Array.from({ length: 12 }, (_, i) => {
      const input = { pair: i % 2 ? "BONK/USDC" : "SOL/USDC", notionalUsd: 1000 * (i + 1), horizonSeconds: 5, capBps: 5, volatility: 2 };
      return { input, expected: predict(m, input) };
    });
    const series: [number, number][] = Array.from({ length: 12 }, (_, i) => [i * 120_000, 100 + (i % 2)]);
    m.featureTestVectors = Array.from({ length: 3 }, () => ({ series, atMs: 11 * 120_000, expectedVol: null as number | null }));
    // Fill in the real volatility for these series.
    return m;
  };

  it("accepts a consistent artifact", async () => {
    const m = withVectors();
    const { realisedVolatility } = await import("./fillModel");
    for (const f of m.featureTestVectors) f.expectedVol = realisedVolatility(f.series.map(([t, price]) => ({ t, price })), f.atMs);
    const result = validateCostModel(JSON.parse(JSON.stringify(m)), schema);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("validates a piecewise artifact, and refuses one whose segments break", async () => {
    const m = withVectors();
    m.impact.perPair["BONK/USDC"].segments = [
      { fromUsd: 0, a: 10, b: 1, n: 100 },
      { fromUsd: 100_000, a: 1, b: 1.5, n: 40 },
    ];
    for (const v of m.selfTestVectors) v.expected = predict(m, v.input);
    const { realisedVolatility } = await import("./fillModel");
    for (const f of m.featureTestVectors) f.expectedVol = realisedVolatility(f.series.map(([t, price]) => ({ t, price })), f.atMs);
    expect(validateCostModel(JSON.parse(JSON.stringify(m)), schema).errors).toEqual([]);

    m.impact.perPair["BONK/USDC"].segments[1].a = 2;
    const broken = validateCostModel(JSON.parse(JSON.stringify(m)), schema);
    expect(broken.ok).toBe(false);
    expect(broken.errors.join("\n")).toMatch(/must be continuous/);
  });

  it("catches a self test that the TypeScript path disagrees with: train/serve skew", () => {
    const m = withVectors();
    m.selfTestVectors[3].expected.impactBps += 0.01;
    const result = validateCostModel(JSON.parse(JSON.stringify(m)), schema);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/impactBps/);
  });

  it("catches a feature computed differently in the notebook", () => {
    const m = withVectors();
    m.featureTestVectors[0].expectedVol = 1.234;
    expect(validateCostModel(JSON.parse(JSON.stringify(m)), schema).errors.join("\n")).toMatch(/volatility/);
  });

  it("rejects structural problems before running anything", () => {
    const m = withVectors() as unknown as Record<string, unknown>;
    delete m.reports;
    m.extra = 1;
    const errors = validateJson(m, schema);
    expect(errors.some((e) => /missing reports/.test(e))).toBe(true);
    expect(errors.some((e) => /unexpected property extra/.test(e))).toBe(true);
  });
});

describe("isLowConfidence", () => {
  it("is true when any part is not ok", () => {
    expect(isLowConfidence({ coverage: { impact: "ok", drift: "ok", failure: "ok" } })).toBe(false);
    expect(isLowConfidence({ coverage: { impact: "ok", drift: "sparse", failure: "ok" } })).toBe(true);
  });
});
