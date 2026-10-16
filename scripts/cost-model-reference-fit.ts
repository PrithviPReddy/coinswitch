/**
 * Writes models/cost-model.example.json: a cost model artifact fitted in
 * TypeScript with the same methods the Colab notebook uses, over the same
 * database.
 *
 *   npm run fit:example-model
 *
 * It exists so the inference loader, the advisor and the backtest have a
 * real, data-derived artifact to work against before the notebook's model
 * comes back, and so the notebook's printed numbers have a reference to be
 * compared with. It is labelled "example only" and is not the cost model.
 *
 * Fitted on the training split only (time-based), like the real model, so a
 * backtest on the held-out period stays honest.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  assignHorizon,
  empiricalQuantiles,
  quantileSorted,
  realisedVolatility,
  type PricePoint,
} from "../app/lib/fillModel";
import {
  depthOf,
  driftFeatures,
  exceedance,
  predict,
  predictDriftAdverse,
  predictImpact,
  shortHorizonDistribution,
  volBucket,
  type CostModel,
  type PowerLaw,
  type PredictionInput,
} from "../app/lib/costModel";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const { PrismaClient } = createRequire(import.meta.url)("../app/generated/prisma/index.js");

const OUT = path.resolve("models/cost-model.example.json");

// Contract constants (models/cost-model.schema.json).
const HORIZONS = [5, 15, 30, 60];
const IMPACT_FLOOR_BPS = 0.5;
const MAX_LADDER_SPAN_S = 30;
const MIN_CELL_N = 20;
const MIN_CONFIDENT_N = 30;
const BASELINE_NOTIONAL_USD = 25;
const RIDGE_ALPHA = 1.0;
const TRAIN_FRACTION = 0.7;

// Collection phases, for the drift coverage table.
const V2_START = Date.parse("2026-10-16T08:29:15Z");
const LIMITER_FIX = Date.parse("2026-10-16T10:49:57Z");

type Sample = {
  id: string; pair: string; ladderId: string; rung: number; t: number;
  notionalUsd: number | null; impactBps: number | null; price: number;
};
type Drift = { originId: string; pair: string; t: number; elapsedMs: number; driftBps: number };

const median = (xs: number[]) => (xs.length ? quantileSorted([...xs].sort((a, b) => a - b), 0.5) : NaN);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const popStd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

function errors(pred: number[], actual: number[]) {
  const n = actual.length;
  if (!n) return { n, mae: null, rmse: null };
  const d = pred.map((p, i) => p - actual[i]);
  return { n, mae: mean(d.map(Math.abs)), rmse: Math.sqrt(mean(d.map((x) => x * x))) };
}

/** Solves A x = b for a small dense system by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Ridge on standardised features with an unpenalised intercept: what sklearn's Ridge fits. */
function fitRidge(X: number[][], y: number[], alpha: number) {
  const p = X[0].length;
  const means = Array.from({ length: p }, (_, j) => mean(X.map((r) => r[j])));
  const stds = Array.from({ length: p }, (_, j) => popStd(X.map((r) => r[j])));
  const Z = X.map((r) => r.map((v, j) => (stds[j] > 0 ? (v - means[j]) / stds[j] : 0)));
  const ym = mean(y);
  const A = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => Z.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? alpha : 0)),
  );
  const b = Array.from({ length: p }, (_, i) => Z.reduce((s, r, k) => s + r[i] * (y[k] - ym), 0));
  const coef = solve(A, b);
  return { means, stds, coef, intercept: ym };
}

const ridgePredict = (r: ReturnType<typeof fitRidge>, x: number[]) =>
  r.intercept + r.coef.reduce((s, c, j) => s + c * (r.stds[j] > 0 ? (x[j] - r.means[j]) / r.stds[j] : 0), 0);

/** OLS of log10(impact) on log10(N / 1000): a power law impact = a (N/1000)^b. */
function fitPowerLaw(rows: { n: number; impact: number }[]): PowerLaw | null {
  const fit = rows.filter((r) => r.impact > IMPACT_FLOOR_BPS && r.n > 0);
  if (fit.length < 5) return null;
  const x = fit.map((r) => Math.log10(r.n / 1000));
  const y = fit.map((r) => Math.log10(r.impact));
  const mx = mean(x);
  const my = mean(y);
  const sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0);
  if (sxx === 0) return null;
  const b = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / sxx;
  // The coverage range is where the pair has data at all, not just where
  // impact was above the floor: a $100 SOL trade is well sampled even though
  // its impact is too small to enter the log-space fit.
  return {
    a: Math.pow(10, my - b * mx),
    b,
    n: fit.length,
    notionalMinUsd: Math.min(...rows.map((r) => r.n)),
    notionalMaxUsd: Math.max(...rows.map((r) => r.n)),
  };
}

/** Two-sample Kolmogorov-Smirnov statistic. */
function ks(a: number[], b: number[]): number {
  const xs = [...a].sort((p, q) => p - q);
  const ys = [...b].sort((p, q) => p - q);
  let i = 0, j = 0, d = 0;
  while (i < xs.length && j < ys.length) {
    const v = Math.min(xs[i], ys[j]);
    while (i < xs.length && xs[i] <= v) i++;
    while (j < ys.length && ys[j] <= v) j++;
    d = Math.max(d, Math.abs(i / xs.length - j / ys.length));
  }
  return d;
}

async function load() {
  const db = new PrismaClient();
  try {
    const samples = (await db.$queryRaw`
      SELECT id, pair, "ladderId", "ladderRung" AS rung, "sampledAt",
             "notionalUsd"::text AS "notionalUsd", "measuredImpactBps"::text AS "impactBps",
             "effectivePrice"::text AS price
        FROM "QuoteSample"`) as {
      id: string; pair: string; ladderId: string; rung: number; sampledAt: Date;
      notionalUsd: string | null; impactBps: string | null; price: string;
    }[];
    const drifts = (await db.$queryRaw`
      SELECT d."originSampleId" AS "originId", s.pair, s."sampledAt", d."actualElapsedMs" AS "elapsedMs",
             d."driftBps"::text AS "driftBps"
        FROM "QuoteDrift" d JOIN "QuoteSample" s ON s.id = d."originSampleId"`) as {
      originId: string; pair: string; sampledAt: Date; elapsedMs: number; driftBps: string;
    }[];
    return {
      samples: samples.map<Sample>((s) => ({
        id: s.id, pair: s.pair, ladderId: s.ladderId, rung: s.rung, t: s.sampledAt.getTime(),
        notionalUsd: s.notionalUsd === null ? null : Number(s.notionalUsd),
        impactBps: s.impactBps === null ? null : Number(s.impactBps),
        price: Number(s.price),
      })),
      drifts: drifts.map<Drift>((d) => ({
        originId: d.originId, pair: d.pair, t: d.sampledAt.getTime(), elapsedMs: d.elapsedMs, driftBps: Number(d.driftBps),
      })),
    };
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  const { samples, drifts } = await load();
  const pairs = [...new Set(samples.map((s) => s.pair))].sort();

  // Ladder spans, for the impact filter.
  const span = new Map<string, number>();
  const byLadder = new Map<string, number[]>();
  for (const s of samples) (byLadder.get(s.ladderId) ?? byLadder.set(s.ladderId, []).get(s.ladderId)!).push(s.t);
  for (const [id, ts] of byLadder) span.set(id, (Math.max(...ts) - Math.min(...ts)) / 1000);

  // Time split at the 70th percentile of sample times.
  const times = samples.map((s) => s.t).sort((a, b) => a - b);
  const cutoff = times[Math.floor(TRAIN_FRACTION * (times.length - 1))];

  // Rung-1 price series per pair, for volatility.
  const series: Record<string, PricePoint[]> = {};
  for (const s of samples.filter((x) => x.rung === 1).sort((a, b) => a.t - b.t)) {
    (series[s.pair] ??= []).push({ t: s.t, price: s.price });
  }

  // ---- impact ----
  const impactRows = samples.filter(
    (s) => s.rung >= 2 && s.notionalUsd !== null && s.impactBps !== null && (span.get(s.ladderId) ?? 0) <= MAX_LADDER_SPAN_S,
  );
  const train = impactRows.filter((s) => s.t < cutoff);
  const test = impactRows.filter((s) => s.t >= cutoff);

  const perPair: Record<string, PowerLaw> = {};
  for (const pair of pairs) {
    const fit = fitPowerLaw(train.filter((s) => s.pair === pair).map((s) => ({ n: s.notionalUsd!, impact: s.impactBps! })));
    if (fit) perPair[pair] = fit;
  }
  const byDepth: Partial<Record<"deep" | "thin", PowerLaw>> = {};
  for (const depth of ["deep", "thin"] as const) {
    const fit = fitPowerLaw(train.filter((s) => depthOf(s.pair) === depth).map((s) => ({ n: s.notionalUsd!, impact: s.impactBps! })));
    if (fit) byDepth[depth] = fit;
  }

  const impactCells: CostModel["impact"]["cells"] = [];
  for (const pair of pairs) {
    for (let rung = 0; rung <= 8; rung++) {
      const rows = samples.filter((s) => s.pair === pair && s.rung === rung && s.notionalUsd !== null && (span.get(s.ladderId) ?? 0) <= MAX_LADDER_SPAN_S);
      if (rows.length) impactCells.push({ pair, rung, notionalUsd: median(rows.map((r) => r.notionalUsd!)), n: rows.length });
    }
  }

  // Ridge baseline for impact, reported only.
  const impactX = (s: Sample) => {
    const thin = depthOf(s.pair) === "thin" ? 1 : 0;
    const l = Math.log10(s.notionalUsd!);
    return [l, thin, thin * l];
  };
  const impactRidge = fitRidge(train.map(impactX), train.map((s) => s.impactBps!), RIDGE_ALPHA);

  // ---- drift ----
  const volCache = new Map<string, number | null>();
  const volAt = (d: Drift) => {
    if (!volCache.has(d.originId)) volCache.set(d.originId, realisedVolatility(series[d.pair] ?? [], d.t));
    return volCache.get(d.originId)!;
  };
  const driftRows = drifts
    .map((d) => ({ ...d, h: assignHorizon(d.elapsedMs) }))
    .filter((d): d is Drift & { h: number } => d.h !== null);
  const withVol = driftRows.map((d) => ({ ...d, vol: volAt(d) })).filter((d) => d.vol !== null) as (Drift & { h: number; vol: number })[];
  const dTrain = withVol.filter((d) => d.t < cutoff);
  const dTest = withVol.filter((d) => d.t >= cutoff);

  const dX = (d: { pair: string; elapsedMs: number; vol: number }) => driftFeatures(d.pair, d.elapsedMs / 1000, d.vol);
  const driftRidge = fitRidge(dTrain.map(dX), dTrain.map((d) => Math.max(0, d.driftBps)), RIDGE_ALPHA);

  const volFallbackByPair: Record<string, number> = {};
  for (const pair of pairs) {
    const v = [...new Set(dTrain.filter((d) => d.pair === pair).map((d) => d.originId))].map((id) => volCache.get(id)!).filter((x) => x !== null);
    if (v.length) volFallbackByPair[pair] = median(v);
  }
  const volFallbackByDepth: Record<string, number> = {};
  for (const depth of ["deep", "thin"]) {
    const v = dTrain.filter((d) => depthOf(d.pair) === depth).map((d) => d.vol);
    if (v.length) volFallbackByDepth[depth] = median(v);
  }

  const driftCells: CostModel["drift"]["cells"] = [];
  for (const pair of pairs) for (const h of HORIZONS) {
    const n = driftRows.filter((d) => d.pair === pair && d.h === h).length;
    if (n) driftCells.push({ pair, horizonSeconds: h, n });
  }

  // ---- short-horizon distributions (train only) ----
  const trainDriftAll = driftRows.filter((d) => d.t < cutoff);
  const volTertiles: Record<string, [number, number] | null> = {};
  for (const pair of pairs) {
    const v = [...new Set(trainDriftAll.filter((d) => d.pair === pair).map((d) => d.originId))]
      .map((id) => volCache.get(id) ?? (volCache.set(id, null), null))
      .filter((x): x is number => x !== null)
      .sort((a, b) => a - b);
    volTertiles[pair] = v.length >= 3 * MIN_CELL_N ? [quantileSorted(v, 1 / 3), quantileSorted(v, 2 / 3)] : null;
  }
  const groups: Record<string, number[]> = {};
  for (const d of trainDriftAll) {
    const vol = volCache.has(d.originId) ? volCache.get(d.originId)! : volAt(d);
    const bucket = volBucket(vol, volTertiles[d.pair]);
    const keys = [`${d.pair}|${d.h}|all`, `${depthOf(d.pair)}|${d.h}|all`];
    if (bucket) keys.push(`${d.pair}|${d.h}|${bucket}`);
    for (const k of keys) (groups[k] ??= []).push(d.driftBps);
  }
  const cells: CostModel["shortHorizon"]["cells"] = {};
  for (const [k, v] of Object.entries(groups)) if (v.length >= MIN_CELL_N) cells[k] = { n: v.length, q: empiricalQuantiles(v) };

  // ---- assemble (metrics need the predictors, which need the model) ----
  const model: CostModel = {
    kind: "coinswitch-cost-model",
    schemaVersion: 1,
    modelVersion: "pending",
    producer: "ts-reference-fit (example only)",
    trainedAt: new Date().toISOString(),
    datasetRowCounts: { quoteSamples: samples.length, quoteDrift: drifts.length },
    datasetTimeRange: { from: new Date(times[0]).toISOString(), to: new Date(times[times.length - 1]).toISOString() },
    split: {
      method: "time",
      cutoff: new Date(cutoff).toISOString(),
      trainRows: { impact: train.length, drift: dTrain.length },
      testRows: { impact: test.length, drift: dTest.length },
    },
    pairs: Object.fromEntries(pairs.map((p) => [p, depthOf(p)])),
    constants: {
      baselineRung: 1,
      impactFloorBps: IMPACT_FLOOR_BPS,
      maxLadderSpanSeconds: MAX_LADDER_SPAN_S,
      measuredHorizons: HORIZONS,
      minCellN: MIN_CELL_N,
      minConfidentN: MIN_CONFIDENT_N,
      quantilePoints: 101,
    },
    volatility: { windowMinutes: 30, rung: 1, minReturns: 8, maxGapSeconds: 600, unit: "bps per sqrt(minute)" },
    features: [
      { name: "sqrt_horizon_s", derivation: "sqrt(horizonSeconds)", mean: driftRidge.means[0], std: driftRidge.stds[0] },
      { name: "vol_sigma_bps", derivation: "vol_bps_per_sqrt_min * sqrt(horizonSeconds / 60)", mean: driftRidge.means[1], std: driftRidge.stds[1] },
      { name: "thin_sqrt_horizon_s", derivation: "(1 if thin else 0) * sqrt(horizonSeconds)", mean: driftRidge.means[2], std: driftRidge.stds[2] },
    ],
    impact: { model: "powerlaw", baselineNotionalUsd: BASELINE_NOTIONAL_USD, perPair, byDepth, cells: impactCells },
    drift: {
      target: "expected adverse drift E[max(0, D_T)] in bps; D positive = trader gets less",
      model: "ridge",
      alpha: RIDGE_ALPHA,
      intercept: driftRidge.intercept,
      coef: driftRidge.coef,
      volFallbackByPair,
      volFallbackByDepth,
      cells: driftCells,
    },
    shortHorizon: { volTertiles, cells },
    metrics: {},
    reports: { driftCoverage: [], impactTable: [], directionalTest: [] },
    limitations: [],
    selfTestVectors: [],
    featureTestVectors: [],
  };

  // ---- metrics, per depth, every one with its n ----
  const byDepthMetrics = <T>(rows: T[], depth: (r: T) => string, pred: (r: T) => number, actual: (r: T) => number) =>
    Object.fromEntries(["deep", "thin"].map((dc) => {
      const rs = rows.filter((r) => depth(r) === dc);
      return [dc, errors(rs.map(pred), rs.map(actual))];
    }));

  model.metrics.impact = {
    powerLaw: byDepthMetrics(test, (s) => depthOf(s.pair), (s) => predictImpact(model, s.pair, s.notionalUsd!).value, (s) => s.impactBps!),
    ridgeBaseline: byDepthMetrics(test, (s) => depthOf(s.pair), (s) => ridgePredict(impactRidge, impactX(s)), (s) => s.impactBps!),
  };

  const trainMeanByCell: Record<string, number> = {};
  for (const dc of ["deep", "thin"]) for (const h of HORIZONS) {
    const v = dTrain.filter((d) => depthOf(d.pair) === dc && d.h === h).map((d) => Math.max(0, d.driftBps));
    trainMeanByCell[`${dc}|${h}`] = v.length ? mean(v) : 0;
  }
  model.metrics.drift = {
    ridge: byDepthMetrics(dTest, (d) => depthOf(d.pair), (d) => predictDriftAdverse(model, d.pair, d.elapsedMs / 1000, d.vol).value, (d) => Math.max(0, d.driftBps)),
    trainMeanBaseline: byDepthMetrics(dTest, (d) => depthOf(d.pair), (d) => trainMeanByCell[`${depthOf(d.pair)}|${d.h}`], (d) => Math.max(0, d.driftBps)),
  };

  // Failure probability: Brier score and a reliability table on the test split,
  // at the execution horizons, over a grid of caps.
  const CAPS = [1, 2, 5, 10, 20, 50];
  const testDriftAll = driftRows.filter((d) => d.t >= cutoff && (d.h === 5 || d.h === 15));
  const calibration: Record<string, unknown>[] = [];
  const brier: Record<string, { n: number; brier: number | null }> = {};
  for (const dc of ["deep", "thin"]) {
    const preds: { p: number; y: number }[] = [];
    for (const d of testDriftAll.filter((x) => depthOf(x.pair) === dc)) {
      const vol = volCache.has(d.originId) ? volCache.get(d.originId)! : volAt(d);
      const dist = shortHorizonDistribution(model, d.pair, d.h, vol);
      if (!dist) continue;
      for (const cap of CAPS) preds.push({ p: exceedance(dist.q, cap), y: d.driftBps > cap ? 1 : 0 });
    }
    brier[dc] = { n: preds.length, brier: preds.length ? mean(preds.map((r) => (r.p - r.y) ** 2)) : null };
    for (let bin = 0; bin < 10; bin++) {
      const rs = preds.filter((r) => Math.min(9, Math.floor(r.p * 10)) === bin);
      if (rs.length) {
        calibration.push({ depth: dc, bin: `${bin / 10}-${(bin + 1) / 10}`, meanPredicted: mean(rs.map((r) => r.p)), observedRate: mean(rs.map((r) => r.y)), n: rs.length });
      }
    }
  }
  model.metrics.failure = { empirical: brier };

  // ---- reports ----
  const phaseOf = (t: number) => (t < V2_START ? "1 v1" : t < LIMITER_FIX ? "2 v2 before limiter fix" : "3 v2 after limiter fix");
  const coverage: Record<string, unknown>[] = [];
  for (const phase of ["1 v1", "2 v2 before limiter fix", "3 v2 after limiter fix"]) {
    for (const dc of ["deep", "thin"]) {
      const inPhase = drifts.filter((d) => phaseOf(d.t) === phase && depthOf(d.pair) === dc);
      const origins = new Set(inPhase.map((d) => d.originId));
      for (const h of HORIZONS) {
        const onTime = new Set(inPhase.filter((d) => assignHorizon(d.elapsedMs) === h).map((d) => d.originId)).size;
        coverage.push({ phase, depth: dc, horizonSeconds: h, originSets: origins.size, onTime, onTimePct: origins.size ? Math.round((1000 * onTime) / origins.size) / 10 : null, n: origins.size });
      }
    }
  }

  const impactTable: Record<string, unknown>[] = [];
  for (const pair of pairs) for (let rung = 0; rung <= 8; rung++) {
    const v = samples
      .filter((s) => s.pair === pair && s.rung === rung && s.impactBps !== null && s.notionalUsd !== null && (span.get(s.ladderId) ?? 0) <= MAX_LADDER_SPAN_S)
      .sort((a, b) => a.impactBps! - b.impactBps!);
    if (!v.length) continue;
    const bps = v.map((s) => s.impactBps!);
    impactTable.push({ pair, depth: depthOf(pair), rung, notionalUsd: median(v.map((s) => s.notionalUsd!)), n: v.length, p25Bps: quantileSorted(bps, 0.25), medianBps: quantileSorted(bps, 0.5), p75Bps: quantileSorted(bps, 0.75) });
  }

  const directional: Record<string, unknown>[] = [];
  for (const pair of pairs) {
    const [a, b] = pair.split("/");
    const reverse = `${b}/${a}`;
    if (!(pair < reverse) || !pairs.includes(reverse)) continue;
    for (const h of HORIZONS) {
      const fwd = driftRows.filter((d) => d.pair === pair && d.h === h).map((d) => d.driftBps);
      const negRev = driftRows.filter((d) => d.pair === reverse && d.h === h).map((d) => -d.driftBps);
      const enough = fwd.length >= MIN_CELL_N && negRev.length >= MIN_CELL_N;
      const stat = enough ? ks(fwd, negRev) : null;
      const critical = enough ? 1.36 * Math.sqrt((fwd.length + negRev.length) / (fwd.length * negRev.length)) : null;
      directional.push({
        pair, reverse, horizonSeconds: h, nForward: fwd.length, nReverse: negRev.length, n: fwd.length + negRev.length,
        medianForward: fwd.length ? median(fwd) : null, medianNegatedReverse: negRev.length ? median(negRev) : null,
        ks: stat, ksCritical5pct: critical,
        verdict: !enough ? "insufficient data" : stat! <= critical! ? "consistent with sign flip" : "rejects sign flip at 5%",
      });
    }
  }
  model.reports = { driftCoverage: coverage, impactTable, directionalTest: directional, calibration };

  model.limitations = [
    "EXAMPLE ONLY: fitted in TypeScript to exercise the contract, the loader, the advisor and the backtest. The cost model proper is fitted in Colab.",
    "Impact is the cost of naive on-chain execution through Jupiter's AMM routing; RFQ, OTC and centralised venues are not seen.",
    "Dataset spans about a day, with collection gaps (the host slept 05:16-06:30 UTC on 2026-10-16).",
    "Deep-pair +5 s drift before the limiter fix (2026-10-16 10:49 UTC) is sparse and was lost systematically; see reports.driftCoverage.",
    "Drift beyond 60 s is extrapolated from the volatility feature, not measured.",
  ];

  // ---- test vectors ----
  const inputs: PredictionInput[] = [
    { pair: "SOL/USDC", notionalUsd: 100, horizonSeconds: 5, capBps: 50, volatility: 2.5 },
    { pair: "SOL/USDC", notionalUsd: 1_000_000, horizonSeconds: 5, capBps: 50, volatility: null },
    { pair: "USDC/SOL", notionalUsd: 40_000, horizonSeconds: 15, capBps: 10, volatility: 3 },
    { pair: "SOL/USDT", notionalUsd: 5, horizonSeconds: 30, capBps: 5, volatility: 1 },
    { pair: "BONK/USDC", notionalUsd: 100, horizonSeconds: 5, capBps: 1, volatility: 4 },
    { pair: "BONK/USDC", notionalUsd: 200_000, horizonSeconds: 5, capBps: 50, volatility: null },
    { pair: "WIF/USDC", notionalUsd: 10_000, horizonSeconds: 15, capBps: 20, volatility: 5 },
    { pair: "WIF/USDC", notionalUsd: 2_000_000, horizonSeconds: 60, capBps: 50, volatility: 8 },
    { pair: "JUP/USDC", notionalUsd: 40_000, horizonSeconds: 120, capBps: 30, volatility: 4 },
    { pair: "USDC/BONK", notionalUsd: 1_000, horizonSeconds: 5, capBps: 10, volatility: 4 },
    { pair: "SOL/BONK", notionalUsd: 50_000, horizonSeconds: 5, capBps: 50, volatility: null },
    { pair: "USDT/USDC", notionalUsd: 500, horizonSeconds: 5, capBps: 2, volatility: 0.2 },
    { pair: "JUP/USDC", notionalUsd: 20, horizonSeconds: 0, capBps: -5, volatility: 0 },
  ];
  model.selfTestVectors = inputs.map((input) => ({ input, expected: predict(model, input) }));

  const fv: CostModel["featureTestVectors"] = [];
  for (const pair of ["BONK/USDC", "SOL/USDC", "WIF/USDC"]) {
    const s = series[pair] ?? [];
    if (s.length < 20) continue;
    const at = s[s.length - 1].t;
    const window = s.filter((p) => p.t >= at - 31 * 60_000);
    fv.push({ series: window.map((p) => [p.t, p.price]), atMs: at, expectedVol: realisedVolatility(window, at) });
  }
  // One with too few points, one across a gap.
  const sol = series["SOL/USDC"] ?? [];
  if (sol.length >= 4) fv.push({ series: sol.slice(0, 4).map((p) => [p.t, p.price]), atMs: sol[3].t, expectedVol: realisedVolatility(sol.slice(0, 4), sol[3].t) });
  const gapAt = sol.findIndex((p, i) => i > 0 && p.t - sol[i - 1].t > 600_000);
  if (gapAt > 0) {
    const w = sol.slice(Math.max(0, gapAt - 10), gapAt + 10);
    fv.push({ series: w.map((p) => [p.t, p.price]), atMs: w[w.length - 1].t, expectedVol: realisedVolatility(w, w[w.length - 1].t) });
  }
  model.featureTestVectors = fv;

  const digest = crypto.createHash("sha256").update(JSON.stringify({ perPair, cells, coef: driftRidge.coef })).digest("hex").slice(0, 8);
  model.modelVersion = `example-cost-${model.trainedAt.replace(/[-:]/g, "").slice(0, 13)}Z-${digest}`;

  fs.writeFileSync(OUT, JSON.stringify(model, null, 1) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), OUT)}  ${model.modelVersion}`);
  console.log(`split cutoff ${model.split.cutoff}: impact train ${train.length} / test ${test.length}, drift train ${dTrain.length} / test ${dTest.length}`);
  console.log(`power laws: ${Object.entries(perPair).map(([p, f]) => `${p} a=${f.a.toPrecision(3)} b=${f.b.toFixed(2)} n=${f.n}`).join("; ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
