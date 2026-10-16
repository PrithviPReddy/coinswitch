import { describe, expect, it } from "vitest";
import { simulatedFill } from "./fill";
import {
  MIN_OBSERVATIONS,
  assignHorizon,
  buildFillArtifact,
  empiricalQuantiles,
  nearestHorizon,
  negateQuantiles,
  quantileAt,
  realisedVolatility,
  resolveBucket,
  sizeBucket,
  validateFillArtifact,
  type DriftObservation,
  type FillArtifact,
} from "./fillModel";

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

/** n drift observations for one pair and horizon, with given values. */
function drifts(pair: string, values: number[], { notionalUsd = 100, elapsedMs = 5_100 } = {}): DriftObservation[] {
  return values.map((driftBps, i) => ({
    originId: `${pair}-${i}`,
    pair,
    notionalUsd,
    originAtMs: T0 + i * 120_000,
    actualElapsedMs: elapsedMs,
    driftBps,
  }));
}

const range = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

function artifactFrom(observations: DriftObservation[]): FillArtifact {
  return buildFillArtifact({ drifts: observations, priceSeries: {}, builtAt: "2026-10-16T12:00:00Z", version: "test-v1" });
}

describe("horizons", () => {
  it("places a re-quote by the time that actually elapsed", () => {
    expect(assignHorizon(5_100)).toBe(5);
    expect(assignHorizon(6_900)).toBe(5);
    expect(assignHorizon(40_000)).toBeNull(); // a "+5 s" that was really +40 s
    expect(assignHorizon(64_000)).toBe(60);
  });

  it("picks the measured horizon nearest a latency", () => {
    expect(nearestHorizon(1_800)).toBe(5);
    expect(nearestHorizon(11_000)).toBe(15);
    expect(nearestHorizon(50_000)).toBe(60);
  });
});

describe("sizeBucket", () => {
  it("splits at $1k and $20k", () => {
    expect([999, 1_000, 19_999, 20_000].map(sizeBucket)).toEqual(["small", "mid", "mid", "large"]);
  });
});

describe("realisedVolatility", () => {
  const series = (prices: number[], stepMs = 120_000) => prices.map((price, i) => ({ t: T0 + i * stepMs, price }));

  it("is zero for a flat price and null without enough returns", () => {
    const flat = series(range(15, () => 100));
    expect(realisedVolatility(flat, flat[14].t)).toBe(0);
    expect(realisedVolatility(flat.slice(0, 5), flat[4].t)).toBeNull();
  });

  it("scales by interval so 90 s and 120 s sampling agree", () => {
    const zigzag = (step: number) => series(range(16, (i) => (i % 2 ? 100.02 : 100)), step);
    const at120 = realisedVolatility(zigzag(120_000), T0 + 15 * 120_000)!;
    const at90 = realisedVolatility(zigzag(90_000), T0 + 15 * 90_000)!;
    // Same move per step, shorter step: higher per-sqrt-minute volatility,
    // by exactly sqrt(120/90).
    expect(at90 / at120).toBeCloseTo(Math.sqrt(120 / 90), 6);
  });

  it("ignores returns across a collection gap", () => {
    const withGap = [...series(range(9, () => 100)), { t: T0 + 9 * 120_000 + 3_600_000, price: 150 }];
    // The jump to 150 happened across a one-hour gap: not a return.
    expect(realisedVolatility(withGap, withGap[9].t)).toBeNull();
  });
});

describe("quantiles", () => {
  it("stores 101 points and draws by inverse CDF", () => {
    const q = empiricalQuantiles(range(101, (i) => i)); // 0..100
    expect(q).toHaveLength(101);
    expect(quantileAt(q, 0.5)).toBeCloseTo(50, 6);
    expect(quantileAt(q, 0.255)).toBeCloseTo(25.5, 6);
  });

  it("negates a distribution by reflecting it", () => {
    const q = empiricalQuantiles(range(101, (i) => i - 10));
    const neg = negateQuantiles(q);
    expect(neg[0]).toBe(-90);
    expect(neg[100]).toBe(10);
    expect(neg.every((v, i) => i === 0 || v >= neg[i - 1])).toBe(true);
  });
});

describe("buildFillArtifact", () => {
  it("never emits a bucket from fewer than the minimum observations", () => {
    const a = artifactFrom(drifts("BONK/USDC", range(MIN_OBSERVATIONS - 1, (i) => i)));
    expect(a.buckets["5"]).toBeUndefined();
  });

  it("leaves out rows that sit off every horizon, and counts them", () => {
    const a = artifactFrom([
      ...drifts("BONK/USDC", range(25, (i) => i)),
      ...drifts("BONK/USDC", range(5, () => 99), { elapsedMs: 40_000 }),
    ]);
    expect(a.dataset).toMatchObject({ driftRows: 30, driftRowsUsed: 25, driftRowsOffHorizon: 5 });
    expect(a.buckets["5"]["BONK/USDC"].n).toBe(25);
  });

  it("produces something the validator accepts", () => {
    expect(validateFillArtifact(artifactFrom(drifts("SOL/USDC", range(30, (i) => i / 10)))).ok).toBe(true);
  });
});

describe("resolveBucket", () => {
  const artifact = artifactFrom([
    ...drifts("BONK/USDC", range(30, (i) => i - 5)),
    ...drifts("SOL/USDC", range(30, (i) => i / 10)),
  ]);
  const at = (inputSymbol: string, outputSymbol: string, notionalUsd: number | null = 100) =>
    resolveBucket(artifact, { inputSymbol, outputSymbol, notionalUsd, volatility: null, horizonSeconds: 5 });

  it("uses the most specific bucket that has enough data", () => {
    expect(at("BONK", "USDC")).toMatchObject({ level: "pair_size", key: "BONK/USDC|small", reversed: false });
  });

  it("drops to the pair when the swap's size has no bucket", () => {
    expect(at("BONK", "USDC", 50_000)).toMatchObject({ level: "pair", key: "BONK/USDC" });
    expect(at("BONK", "USDC", null)).toMatchObject({ level: "pair" });
  });

  it("uses the sampled market with the sign flipped for the opposite direction", () => {
    const forward = at("BONK", "USDC")!;
    const backward = at("USDC", "BONK")!;
    expect(backward).toMatchObject({ reversed: true, key: "BONK/USDC|small (reversed)" });
    expect(backward.q[0]).toBe(-forward.q[100]);
  });

  it("falls to global for its depth class, never across classes", () => {
    expect(at("SOL", "BONK")).toMatchObject({ level: "global", key: "global|thin" });
    expect(at("USDT", "SOL")).toMatchObject({ level: "global", key: "global|deep" });
  });
});

describe("simulatedFill", () => {
  const artifact = artifactFrom(drifts("BONK/USDC", range(40, (i) => i - 10))); // -10 .. +29 bps
  const base = {
    artifact,
    quotedOut: BigInt(1_000_000_000),
    slippageBps: 50,
    inputSymbol: "BONK",
    outputSymbol: "USDC",
    notionalUsd: 100,
    volatility: null,
    latencyEstimateMs: 2_400,
  };

  it("falls back to an exact fill, and says why, with no artifact", () => {
    const { decision, audit } = simulatedFill({ ...base, artifact: null, u: 0.5 });
    expect(decision).toMatchObject({ mode: "exact", fillOut: BigInt(1_000_000_000) });
    expect(audit).toMatchObject({ bucketLevel: "none", fallbackReason: "no fill model artifact is loaded" });
  });

  it("can land above the quote: the draw is two-sided", () => {
    const { decision, audit } = simulatedFill({ ...base, u: 0 });
    expect(decision.shortfallBps).toBe(-10);
    expect(decision.fillOut > BigInt(1_000_000_000)).toBe(true);
    expect(audit).toMatchObject({ modelVersion: "test-v1", horizonSeconds: 5, bucketKey: "BONK/USDC|small" });
  });

  it("refuses a draw beyond the slippage cap", () => {
    const tight = simulatedFill({ ...base, slippageBps: 20, u: 0.999 });
    expect(tight.decision.shortfallBps).toBeGreaterThan(20);
    expect(tight.decision.withinBound).toBe(false);
  });
});
