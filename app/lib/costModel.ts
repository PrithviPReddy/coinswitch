/**
 * Inference for the cost model artifact (models/cost-model.json), written to
 * the contract in models/cost-model.schema.json. Every rule there is
 * implemented here exactly once; the Colab notebook implements the same rules
 * in numpy, and `npm run validate:model` checks the two agree by re-running
 * the artifact's own selfTestVectors and featureTestVectors through this file.
 *
 * Pure: no network, no database. Every prediction carries a coverage flag,
 * so a caller (and the UI) can tell a well-supported number from a guess.
 */

import { realisedVolatility } from "./fillModel";
import { validateJson } from "./jsonSchema";

export type Coverage = "ok" | "sparse" | "fallback" | "extrapolated" | "none";
export type Depth = "deep" | "thin";

export type PowerLaw = { a: number; b: number; n: number; notionalMinUsd: number; notionalMaxUsd: number };

export type CostModel = {
  kind: "coinswitch-cost-model";
  schemaVersion: 1;
  modelVersion: string;
  producer: string;
  trainedAt: string;
  datasetRowCounts: { quoteSamples: number; quoteDrift: number };
  datasetTimeRange: { from: string; to: string };
  split: { method: "time"; cutoff: string; trainRows: { impact: number; drift: number }; testRows: { impact: number; drift: number } };
  pairs: Record<string, Depth>;
  constants: {
    baselineRung: 1;
    impactFloorBps: number;
    maxLadderSpanSeconds: number;
    measuredHorizons: number[];
    minCellN: number;
    minConfidentN: number;
    quantilePoints: 101;
  };
  volatility: { windowMinutes: number; rung: number; minReturns: number; maxGapSeconds: number; unit: string };
  features: { name: "sqrt_horizon_s" | "vol_sigma_bps" | "thin_sqrt_horizon_s"; derivation: string; mean: number; std: number }[];
  impact: {
    model: "powerlaw";
    baselineNotionalUsd: number;
    perPair: Record<string, PowerLaw>;
    byDepth: Partial<Record<Depth, PowerLaw>>;
    cells: { pair: string; rung: number; notionalUsd: number; n: number }[];
  };
  drift: {
    target: string;
    model: "ridge";
    alpha: number;
    intercept: number;
    coef: number[];
    volFallbackByPair: Record<string, number>;
    volFallbackByDepth: Record<string, number>;
    cells: { pair: string; horizonSeconds: number; n: number }[];
  };
  shortHorizon: {
    volTertiles: Record<string, [number, number] | null>;
    cells: Record<string, { n: number; q: number[] }>;
  };
  metrics: Record<string, Record<string, Record<string, { n: number; [k: string]: number | null }>>>;
  reports: Record<string, Record<string, unknown>[]>;
  limitations: string[];
  selfTestVectors: SelfTestVector[];
  featureTestVectors: { series: [number, number][]; atMs: number; expectedVol: number | null }[];
};

export type PredictionInput = {
  pair: string;
  notionalUsd: number;
  horizonSeconds: number;
  capBps: number;
  volatility: number | null;
};

export type Prediction = {
  impactBps: number;
  driftAdverseBps: number;
  failureProbability: number | null;
  coverage: { impact: Coverage; drift: Coverage; failure: Coverage };
};

export type SelfTestVector = { input: PredictionInput; expected: Prediction };

const THIN = new Set(["JUP", "BONK", "WIF"]);

export function depthOf(pair: string): Depth {
  return pair.split("/").some((s) => THIN.has(s)) ? "thin" : "deep";
}

/** The sampled pair whose data a pair uses, per the contract's PAIR RESOLUTION. */
export function resolvePair(model: CostModel, pair: string): { source: string | null; reversed: boolean } {
  if (model.pairs[pair]) return { source: pair, reversed: false };
  const [input, output] = pair.split("/");
  const reverse = `${output}/${input}`;
  if (model.pairs[reverse]) return { source: reverse, reversed: true };
  return { source: null, reversed: false };
}

/** The measured horizon nearest T; ties go to the shorter one. */
export function nearestMeasuredHorizon(model: CostModel, horizonSeconds: number): number {
  let best = model.constants.measuredHorizons[0];
  for (const h of model.constants.measuredHorizons) {
    if (Math.abs(horizonSeconds - h) < Math.abs(horizonSeconds - best)) best = h;
  }
  return best;
}

export function predictImpact(model: CostModel, pair: string, notionalUsd: number): { value: number; coverage: Coverage } {
  const { source, reversed } = resolvePair(model, pair);
  const own = source ? model.impact.perPair[source] : undefined;
  const params = own ?? model.impact.byDepth[depthOf(pair)];
  if (!params) return { value: 0, coverage: "none" };

  const value =
    notionalUsd <= model.impact.baselineNotionalUsd
      ? 0
      : Math.max(0, params.a * Math.pow(notionalUsd / 1000, params.b));

  let coverage: Coverage = "ok";
  if (!own || reversed) coverage = "fallback";
  else if (notionalUsd < params.notionalMinUsd || notionalUsd > params.notionalMaxUsd) coverage = "extrapolated";
  else if (params.n < model.constants.minConfidentN) coverage = "sparse";

  return { value, coverage };
}

/** The drift model's feature vector, raw, in contract order. */
export function driftFeatures(pair: string, horizonSeconds: number, vol: number): number[] {
  const rootT = Math.sqrt(horizonSeconds);
  return [rootT, vol * Math.sqrt(horizonSeconds / 60), (depthOf(pair) === "thin" ? 1 : 0) * rootT];
}

export function predictDriftAdverse(
  model: CostModel,
  pair: string,
  horizonSeconds: number,
  volatility: number | null,
): { value: number; coverage: Coverage } {
  const { source, reversed } = resolvePair(model, pair);
  const depth = depthOf(pair);

  let vol = volatility;
  let volFallback = false;
  if (vol === null) {
    vol = (source ? model.drift.volFallbackByPair[source] : undefined) ?? model.drift.volFallbackByDepth[depth] ?? 0;
    volFallback = true;
  }

  const x = driftFeatures(pair, horizonSeconds, vol);
  let y = model.drift.intercept;
  model.features.forEach((f, i) => {
    y += model.drift.coef[i] * (f.std > 0 ? (x[i] - f.mean) / f.std : 0);
  });

  const h = nearestMeasuredHorizon(model, horizonSeconds);
  const cell = source ? model.drift.cells.find((c) => c.pair === source && c.horizonSeconds === h) : undefined;

  let coverage: Coverage = "ok";
  if (horizonSeconds > Math.max(...model.constants.measuredHorizons)) coverage = "extrapolated";
  else if (volFallback || reversed || !source) coverage = "fallback";
  else if (!cell || cell.n < model.constants.minConfidentN) coverage = "sparse";

  return { value: Math.max(0, y), coverage };
}

/** P(D > cap) from stored quantiles, exactly as the contract defines it. */
export function exceedance(q: number[], cap: number): number {
  const last = q.length - 1;
  if (cap < q[0]) return 1;
  if (cap >= q[last]) return 0;
  let k = 0;
  for (let j = 0; j < last; j++) if (q[j] <= cap) k = j;
  const u = q[k + 1] > q[k] ? (k + (cap - q[k]) / (q[k + 1] - q[k])) / last : (k + 1) / last;
  return 1 - u;
}

export function negateQuantiles(q: number[]): number[] {
  return q.map((_, k) => -q[q.length - 1 - k] + 0);
}

export function volBucket(vol: number | null, tertiles: [number, number] | null | undefined): "low" | "mid" | "high" | null {
  if (vol === null || !tertiles) return null;
  return vol < tertiles[0] ? "low" : vol < tertiles[1] ? "mid" : "high";
}

/**
 * The short-horizon drift distribution a pair uses at T, with its coverage.
 * Exposed because the advisor needs more than one probability from it.
 */
export function shortHorizonDistribution(
  model: CostModel,
  pair: string,
  horizonSeconds: number,
  volatility: number | null,
): { q: number[]; n: number; coverage: Coverage } | null {
  const h = nearestMeasuredHorizon(model, horizonSeconds);
  const extrapolated = horizonSeconds > Math.max(...model.constants.measuredHorizons);
  const { source, reversed } = resolvePair(model, pair);

  let found: { n: number; q: number[] } | undefined;
  let level: "pair" | "depth" = "pair";

  if (source) {
    const bucket = volBucket(volatility, model.shortHorizon.volTertiles[source]);
    const keys = [bucket ? `${source}|${h}|${bucket}` : null, `${source}|${h}|all`];
    for (const key of keys) {
      if (key && model.shortHorizon.cells[key]) {
        found = model.shortHorizon.cells[key];
        break;
      }
    }
  }
  if (!found) {
    found = model.shortHorizon.cells[`${depthOf(pair)}|${h}|all`];
    level = "depth";
  }
  if (!found) return null;

  const q = reversed && level === "pair" ? negateQuantiles(found.q) : found.q;

  let coverage: Coverage = "ok";
  if (extrapolated) coverage = "extrapolated";
  else if (level === "depth" || reversed) coverage = "fallback";
  else if (found.n < model.constants.minConfidentN) coverage = "sparse";

  return { q, n: found.n, coverage };
}

export function predictFailure(
  model: CostModel,
  pair: string,
  horizonSeconds: number,
  capBps: number,
  volatility: number | null,
): { value: number | null; coverage: Coverage } {
  const dist = shortHorizonDistribution(model, pair, horizonSeconds, volatility);
  if (!dist) return { value: null, coverage: "none" };
  return { value: exceedance(dist.q, capBps), coverage: dist.coverage };
}

export function predict(model: CostModel, input: PredictionInput): Prediction {
  const impact = predictImpact(model, input.pair, input.notionalUsd);
  const drift = predictDriftAdverse(model, input.pair, input.horizonSeconds, input.volatility);
  const failure = predictFailure(model, input.pair, input.horizonSeconds, input.capBps, input.volatility);
  return {
    impactBps: impact.value,
    driftAdverseBps: drift.value,
    failureProbability: failure.value,
    coverage: { impact: impact.coverage, drift: drift.coverage, failure: failure.coverage },
  };
}

/** True when any part of a prediction comes from a sparse or borrowed region. */
export function isLowConfidence(prediction: Pick<Prediction, "coverage">): boolean {
  return Object.values(prediction.coverage).some((c) => c !== "ok");
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 + 1e-9 * Math.abs(b);

export type TestResult = { index: number; ok: boolean; problems: string[] };

export function runSelfTests(model: CostModel): TestResult[] {
  return model.selfTestVectors.map(({ input, expected }, index) => {
    const got = predict(model, input);
    const problems: string[] = [];
    for (const key of ["impactBps", "driftAdverseBps"] as const) {
      if (!close(got[key], expected[key])) problems.push(`${key}: got ${got[key]}, expected ${expected[key]}`);
    }
    const gf = got.failureProbability;
    const ef = expected.failureProbability;
    if ((gf === null) !== (ef === null) || (gf !== null && ef !== null && !close(gf, ef))) {
      problems.push(`failureProbability: got ${gf}, expected ${ef}`);
    }
    for (const part of ["impact", "drift", "failure"] as const) {
      if (got.coverage[part] !== expected.coverage[part]) {
        problems.push(`coverage.${part}: got ${got.coverage[part]}, expected ${expected.coverage[part]}`);
      }
    }
    return { index, ok: problems.length === 0, problems };
  });
}

export function runFeatureTests(model: CostModel): TestResult[] {
  return model.featureTestVectors.map(({ series, atMs, expectedVol }, index) => {
    const got = realisedVolatility(series.map(([t, price]) => ({ t, price })), atMs);
    const ok = got === null || expectedVol === null ? got === expectedVol : close(got, expectedVol);
    return { index, ok, problems: ok ? [] : [`volatility: got ${got}, expected ${expectedVol}`] };
  });
}

/** Schema check, then both test-vector suites. Empty `errors` means the artifact is safe to serve. */
export function validateCostModel(
  value: unknown,
  schema: Record<string, unknown>,
): { ok: boolean; errors: string[]; model: CostModel | null; selfTests: TestResult[]; featureTests: TestResult[] } {
  const schemaErrors = validateJson(value, schema);
  if (schemaErrors.length) {
    return { ok: false, errors: schemaErrors, model: null, selfTests: [], featureTests: [] };
  }

  const model = value as CostModel;
  const errors: string[] = [];

  const names = model.features.map((f) => f.name).join(",");
  if (names !== "sqrt_horizon_s,vol_sigma_bps,thin_sqrt_horizon_s") {
    errors.push(`features must be [sqrt_horizon_s, vol_sigma_bps, thin_sqrt_horizon_s] in that order, got [${names}]`);
  }
  for (const [key, cell] of Object.entries(model.shortHorizon.cells)) {
    if (cell.q.some((v, i) => i > 0 && v < cell.q[i - 1])) errors.push(`shortHorizon.cells.${key}: quantiles not ascending`);
    if (cell.n < model.constants.minCellN) errors.push(`shortHorizon.cells.${key}: n ${cell.n} below minCellN`);
  }

  const selfTests = runSelfTests(model);
  const featureTests = runFeatureTests(model);
  for (const t of [...selfTests, ...featureTests]) {
    if (!t.ok) errors.push(...t.problems);
  }

  return { ok: errors.length === 0, errors, model, selfTests, featureTests };
}
