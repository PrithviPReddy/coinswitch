/**
 * The empirical fill model: what the vault pays out, relative to the quote,
 * when FILL_MODE=simulated.
 *
 * What it models: adverse price drift between quote and settlement, measured
 * by the sampler re-asking the same mainnet quote 5, 15, 30 and 60 s later
 * (QuoteDrift). It is drawn two-sided from the measured distribution, so a
 * simulated fill can land above the quote as well as below it.
 *
 * What it does not model: price impact (already inside the quoted amount),
 * MEV extraction (never measured, so never simulated), or any real execution.
 * A simulated fill is a draw from recorded quote drift, applied to a devnet
 * settlement. It is not observed slippage.
 *
 * This module is pure and shared: scripts/build-fill-model.ts builds the
 * artifact with it, and the app reads the artifact and computes the same
 * features with it at swap time, so the two can never drift apart.
 */

export const FILL_MODEL_KIND = "coinswitch-fill-model";
export const FILL_MODEL_SCHEMA_VERSION = 1;

/** Drift horizons the sampler measures, in seconds. */
export const HORIZONS = [5, 15, 30, 60] as const;

/** A bucket needs at least this many observations to be used at all. */
export const MIN_OBSERVATIONS = 20;

/** Quantiles stored per bucket: p = 0, 0.01, ..., 1. */
export const QUANTILE_POINTS = 101;

/** Notional edges, USD: small < 1,000 <= mid < 20,000 <= large. */
export const SIZE_EDGES_USD = [1_000, 20_000] as const;

export const VOLATILITY = {
  windowMinutes: 30,
  /** Fewer returns than this in the window and there is no volatility value. */
  minReturns: 8,
  /** A return across a longer gap (a collection outage) is not a return. */
  maxGapSeconds: 600,
  /** The ~$25 rung: the impact baseline, and the least impact-contaminated. */
  rung: 1,
  unit: "bps per sqrt(minute)",
} as const;

const THIN_TOKENS = new Set(["JUP", "BONK", "WIF"]);

export type SizeBucket = "small" | "mid" | "large";
export type VolBucket = "low" | "mid" | "high";
export type BucketLevel = "pair_size_vol" | "pair_size" | "pair" | "global";
export type Depth = "deep" | "thin";

export type Bucket = { level: BucketLevel; n: number; q: number[] };

export type FillArtifact = {
  kind: typeof FILL_MODEL_KIND;
  schemaVersion: number;
  version: string;
  builtAt: string;
  dataset: {
    driftRows: number;
    driftRowsUsed: number;
    driftRowsOffHorizon: number;
    from: string | null;
    to: string | null;
  };
  minObservations: number;
  horizons: number[];
  quantilePoints: number;
  sizeEdgesUsd: number[];
  volatility: typeof VOLATILITY & {
    /** Per-pair tertile cut points, or null where there were too few values. */
    tertiles: Record<string, [number, number] | null>;
  };
  /** Every sampled pair and its depth class. */
  pairs: Record<string, Depth>;
  /** buckets[horizon][key]: only buckets with n >= minObservations exist. */
  buckets: Record<string, Record<string, Bucket>>;
};

export function depthOfPair(pair: string): Depth {
  return pair.split("/").some((t) => THIN_TOKENS.has(t)) ? "thin" : "deep";
}

export function sizeBucket(notionalUsd: number): SizeBucket {
  if (notionalUsd < SIZE_EDGES_USD[0]) return "small";
  if (notionalUsd < SIZE_EDGES_USD[1]) return "mid";
  return "large";
}

/** How far a re-quote may sit from a horizon and still count as that horizon. */
export function horizonToleranceMs(horizonSeconds: number): number {
  return Math.max(2_000, horizonSeconds * 250);
}

/**
 * The horizon a drift row measures, from the time that actually elapsed, or
 * null when it is not close enough to any. Rows recorded before the sampler's
 * lateness guard can be far off their nominal delay; they are placed by what
 * really happened, or left out.
 */
export function assignHorizon(actualElapsedMs: number): number | null {
  for (const h of HORIZONS) {
    if (Math.abs(actualElapsedMs - h * 1000) <= horizonToleranceMs(h)) return h;
  }
  return null;
}

/** The measured horizon nearest a latency. Used at swap time. */
export function nearestHorizon(latencyMs: number): number {
  let best: number = HORIZONS[0];
  for (const h of HORIZONS) {
    if (Math.abs(latencyMs - h * 1000) < Math.abs(latencyMs - best * 1000)) best = h;
  }
  return best;
}

export type PricePoint = { t: number; price: number };

/**
 * Realised volatility at time `atMs`: the sample standard deviation of log
 * returns of the small-rung price over the trailing window, each return
 * scaled by 1/sqrt(its interval in minutes) so ladders 90 s or 120 s apart
 * are comparable. In bps per sqrt(minute). Null when the window holds too
 * few returns (a pair just started, or the sampler was paused or asleep).
 *
 * `points` must be sorted by t.
 */
export function realisedVolatility(points: PricePoint[], atMs: number): number | null {
  const from = atMs - VOLATILITY.windowMinutes * 60_000;
  const scaled: number[] = [];

  let prev: PricePoint | null = null;
  for (const p of points) {
    if (p.t > atMs) break;
    if (p.t < from) continue;
    if (prev && p.price > 0 && prev.price > 0) {
      const dtMs = p.t - prev.t;
      if (dtMs > 0 && dtMs <= VOLATILITY.maxGapSeconds * 1000) {
        scaled.push(Math.log(p.price / prev.price) / Math.sqrt(dtMs / 60_000));
      }
    }
    prev = p;
  }

  if (scaled.length < VOLATILITY.minReturns) return null;

  const mean = scaled.reduce((a, b) => a + b, 0) / scaled.length;
  const variance = scaled.reduce((a, b) => a + (b - mean) ** 2, 0) / (scaled.length - 1);
  return Math.sqrt(variance) * 10_000;
}

export function volBucket(vol: number | null, tertiles: [number, number] | null | undefined): VolBucket | null {
  if (vol === null || !tertiles) return null;
  if (vol < tertiles[0]) return "low";
  if (vol < tertiles[1]) return "mid";
  return "high";
}

/** Type-7 (linear) quantile of sorted values at probability p. */
export function quantileSorted(sorted: number[], p: number): number {
  if (!sorted.length) throw new Error("quantile of nothing");
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function empiricalQuantiles(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return Array.from({ length: QUANTILE_POINTS }, (_, k) =>
    round6(quantileSorted(sorted, k / (QUANTILE_POINTS - 1))),
  );
}

/**
 * Draws from a stored quantile function: u in [0, 1) picks a point on the
 * inverse CDF, linearly between the stored percentiles.
 */
export function quantileAt(q: number[], u: number): number {
  const h = Math.min(Math.max(u, 0), 1) * (q.length - 1);
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, q.length - 1);
  return q[lo] + (h - lo) * (q[hi] - q[lo]);
}

/** The distribution of -X, from the quantiles of X. */
export function negateQuantiles(q: number[]): number[] {
  return q.map((_, k) => round6(-q[q.length - 1 - k] + 0));
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function bucketKeys(pair: string, size: SizeBucket, vol: VolBucket | null) {
  return {
    pair_size_vol: vol ? `${pair}|${size}|${vol}` : null,
    pair_size: `${pair}|${size}`,
    pair,
    global: `global|${depthOfPair(pair)}`,
  };
}

export type ResolvedBucket = {
  level: BucketLevel;
  /** The key used, with " (reversed)" when the opposite direction supplied it. */
  key: string;
  n: number;
  q: number[];
  /** The sampled pair whose data was used, or null for the global level. */
  sourcePair: string | null;
  reversed: boolean;
};

/**
 * Finds the most specific bucket with enough data, walking
 * pair x size x vol -> pair x size -> pair -> global (per depth class).
 *
 * A swap in a sampled direction uses that pair. A swap in the opposite
 * direction (USDC->BONK when BONK->USDC was sampled) uses the same market
 * with the sign flipped: a move that costs a seller of BONK pays a buyer.
 * Anything else, such as SOL->BONK, falls to the global level for its depth
 * class, so a thin-token swap never draws from deep-pair data.
 */
export function resolveBucket(
  artifact: FillArtifact,
  {
    inputSymbol,
    outputSymbol,
    notionalUsd,
    volatility,
    horizonSeconds,
  }: {
    inputSymbol: string;
    outputSymbol: string;
    /** Null when there was no price to value the swap; size levels are then skipped. */
    notionalUsd: number | null;
    volatility: number | null;
    horizonSeconds: number;
  },
): ResolvedBucket | null {
  const byHorizon = artifact.buckets[String(horizonSeconds)] ?? {};
  const forward = `${inputSymbol}/${outputSymbol}`;
  const backward = `${outputSymbol}/${inputSymbol}`;

  const source = artifact.pairs[forward] ? forward : artifact.pairs[backward] ? backward : null;
  const reversed = source === backward;
  if (source) {
    const vol = volBucket(volatility, artifact.volatility.tertiles[source]);
    const keys = bucketKeys(source, notionalUsd === null ? "small" : sizeBucket(notionalUsd), vol);
    for (const level of ["pair_size_vol", "pair_size", "pair"] as const) {
      const key = notionalUsd === null && level !== "pair" ? null : keys[level];
      const bucket = key ? byHorizon[key] : undefined;
      if (key && bucket) {
        return {
          level,
          key: reversed ? `${key} (reversed)` : key,
          n: bucket.n,
          q: reversed ? negateQuantiles(bucket.q) : bucket.q,
          sourcePair: source,
          reversed,
        };
      }
    }
  }

  const depth: Depth =
    THIN_TOKENS.has(inputSymbol) || THIN_TOKENS.has(outputSymbol) ? "thin" : "deep";
  const globalKey = `global|${depth}`;
  const global = byHorizon[globalKey];
  return global
    ? { level: "global", key: globalKey, n: global.n, q: global.q, sourcePair: null, reversed: false }
    : null;
}

export type DriftObservation = {
  originId: string;
  pair: string;
  notionalUsd: number;
  originAtMs: number;
  actualElapsedMs: number;
  driftBps: number;
};

/**
 * Builds the artifact from recorded drift and small-rung price series. Pure:
 * the caller does the database reads and supplies the version and time.
 */
export function buildFillArtifact({
  drifts,
  priceSeries,
  builtAt,
  version,
}: {
  drifts: DriftObservation[];
  /** Per pair, the rung-1 effective price over time, sorted by t. */
  priceSeries: Record<string, PricePoint[]>;
  builtAt: string;
  version: string;
}): FillArtifact {
  // Volatility at each origin, once per origin.
  const volAtOrigin = new Map<string, number | null>();
  for (const d of drifts) {
    if (!volAtOrigin.has(d.originId)) {
      volAtOrigin.set(d.originId, realisedVolatility(priceSeries[d.pair] ?? [], d.originAtMs));
    }
  }

  // Tertiles per pair, only where there are enough values to cut three ways.
  const pairs = [...new Set(drifts.map((d) => d.pair))].sort();
  const tertiles: Record<string, [number, number] | null> = {};
  for (const pair of pairs) {
    const ids = new Set(drifts.filter((d) => d.pair === pair).map((d) => d.originId));
    const vols = [...ids]
      .map((id) => volAtOrigin.get(id))
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);
    tertiles[pair] =
      vols.length >= 3 * MIN_OBSERVATIONS
        ? [round6(quantileSorted(vols, 1 / 3)), round6(quantileSorted(vols, 2 / 3))]
        : null;
  }

  const grouped: Record<string, Record<string, { level: BucketLevel; values: number[] }>> = {};
  let used = 0;
  let offHorizon = 0;

  for (const d of drifts) {
    const h = assignHorizon(d.actualElapsedMs);
    if (h === null) {
      offHorizon++;
      continue;
    }
    used++;

    const vol = volBucket(volAtOrigin.get(d.originId) ?? null, tertiles[d.pair]);
    const keys = bucketKeys(d.pair, sizeBucket(d.notionalUsd), vol);
    const forH = (grouped[h] ??= {});

    for (const level of ["pair_size_vol", "pair_size", "pair", "global"] as const) {
      const key = keys[level];
      if (!key) continue;
      (forH[key] ??= { level, values: [] }).values.push(d.driftBps);
    }
  }

  const buckets: FillArtifact["buckets"] = {};
  for (const [h, forH] of Object.entries(grouped)) {
    for (const [key, { level, values }] of Object.entries(forH)) {
      if (values.length < MIN_OBSERVATIONS) continue;
      (buckets[h] ??= {})[key] = { level, n: values.length, q: empiricalQuantiles(values) };
    }
  }

  const times = drifts.map((d) => d.originAtMs).sort((a, b) => a - b);

  return {
    kind: FILL_MODEL_KIND,
    schemaVersion: FILL_MODEL_SCHEMA_VERSION,
    version,
    builtAt,
    dataset: {
      driftRows: drifts.length,
      driftRowsUsed: used,
      driftRowsOffHorizon: offHorizon,
      from: times.length ? new Date(times[0]).toISOString() : null,
      to: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    },
    minObservations: MIN_OBSERVATIONS,
    horizons: [...HORIZONS],
    quantilePoints: QUANTILE_POINTS,
    sizeEdgesUsd: [...SIZE_EDGES_USD],
    volatility: { ...VOLATILITY, tertiles },
    pairs: Object.fromEntries(pairs.map((p) => [p, depthOfPair(p)])),
    buckets,
  };
}

/**
 * Structural check of an artifact read from disk. Anything that fails here
 * means the app falls back to exact fills rather than drawing from a
 * distribution it cannot trust.
 */
export function validateFillArtifact(x: unknown): { ok: true; artifact: FillArtifact } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const a = x as Partial<FillArtifact> | null;

  if (!a || typeof a !== "object") return { ok: false, errors: ["not an object"] };
  if (a.kind !== FILL_MODEL_KIND) errors.push(`kind is ${String(a.kind)}`);
  if (a.schemaVersion !== FILL_MODEL_SCHEMA_VERSION) errors.push(`schemaVersion is ${String(a.schemaVersion)}`);
  if (typeof a.version !== "string" || !a.version) errors.push("version missing");
  if (!a.pairs || typeof a.pairs !== "object") errors.push("pairs missing");
  if (!a.volatility || typeof a.volatility.tertiles !== "object") errors.push("volatility.tertiles missing");
  if (!a.buckets || typeof a.buckets !== "object") errors.push("buckets missing");

  for (const [h, forH] of Object.entries(a.buckets ?? {})) {
    for (const [key, b] of Object.entries(forH ?? {})) {
      const ok =
        b &&
        Array.isArray(b.q) &&
        b.q.length === QUANTILE_POINTS &&
        b.q.every((v, i) => Number.isFinite(v) && (i === 0 || v >= b.q[i - 1])) &&
        Number.isInteger(b.n) &&
        b.n >= MIN_OBSERVATIONS;
      if (!ok) errors.push(`bucket ${h}/${key} is malformed or too sparse`);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, artifact: a as FillArtifact };
}
