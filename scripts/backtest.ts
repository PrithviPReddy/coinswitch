/**
 * Backtest of the execution-mode advisor on HELD-OUT recorded mainnet quotes.
 *
 *   npm run backtest                         uses models/cost-model.json, else the example
 *   npm run backtest -- path/to/model.json
 *
 * Writes reports/backtest/: orders.csv, summary.json, summary.md and charts
 * (SVG, plus PNG where macOS can render them).
 *
 * What it does. Every held-out ladder (sampled at or after the model's
 * training cutoff) that has a recorded +5 s drift re-quote becomes a set of
 * synthetic orders, one per rung size from ~$100 to ~$1M. The REAL advisor
 * (app/lib/advisor.ts) and the REAL loader (app/lib/costModel.ts) choose a
 * mode from information available at that moment only: the trained model
 * and the realised volatility of the pair's past samples. What each mode
 * WOULD have cost is then read from the recorded series that followed:
 *
 *   impact     the recorded ladder's impact curve (rungs 1-8, log-notional
 *              interpolation), at the ladder nearest each portion's time
 *   drift      the recorded re-quote path at +5/15/30/60 s, then the change
 *              in the rung-1 price to the ladder nearest each later time
 *   failure    a fill fails when the recorded drift over its latency beats
 *              its cap. It pays its fee, and the order (or portion) still has
 *              to be filled: it is COMPLETED at the pair's next recorded
 *              ladder, paying the recorded price change while waiting plus
 *              that ladder's impact. So every strategy ends with the order
 *              filled, and not trading is never counted as a saving. Failed
 *              split portions are completed on top of whatever displacement
 *              our filled portions left (one more rho step), so at rho = 0 a
 *              failure cannot escape the impact a never-recovering pool owes.
 *   recovery   rho, unmeasured, swept over [0, 1] with the same
 *              displacement accounting the advisor uses (splitImpactBps)
 *
 * Nothing is simulated: every realised number is read from rows the
 * sampler recorded. Strategies: the advisor, always-SEND_NOW (the control),
 * and a fixed split into 4 portions over 30 s.
 *
 * Limits, stated in the output too: retries in TIGHTEN_AND_RETRY are priced
 * on the recorded 5->15 s and 15->30 s moves, so retry gaps are 10-15 s
 * rather than 5 s, overstating retry drift; drift beyond 60 s comes from
 * ladders every 120 s, so it is coarse; and our own portions never moved any
 * recorded pool, which is exactly why rho is a parameter.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  DEFAULT_ADVISOR_PARAMS,
  advise,
  portionDelays,
  splitImpactBps,
  type Advice,
  type Candidate,
} from "../app/lib/advisor";
import { depthOf, validateCostModel, type CostModel } from "../app/lib/costModel";
import { assignHorizon, quantileSorted, realisedVolatility, type PricePoint } from "../app/lib/fillModel";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const { PrismaClient } = createRequire(import.meta.url)("../app/generated/prisma/index.js");

const OUT = path.resolve("reports/backtest");
const RHOS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const CAPS_BPS = [50, 5];
const FIXED_SPLIT = { k: 4, windowSeconds: 30 };
const LADDER_MATCH_MS = 90_000;
const SIZE_BUCKETS: [string, number, number][] = [
  ["~$100", 0, 300],
  ["~$500", 300, 1_200],
  ["~$2k", 1_200, 5_000],
  ["~$10k", 5_000, 25_000],
  ["~$40k", 25_000, 100_000],
  ["~$200k", 100_000, 500_000],
  ["~$1M", 500_000, Infinity],
];
const sizeBucket = (usd: number) => SIZE_BUCKETS.find(([, lo, hi]) => usd >= lo && usd < hi)![0];

// ---------- model ----------

/**
 *   npm run backtest [-- model.json] [-- --until 2026-10-17T12:00:00Z]
 *
 * --until fixes the data to rows recorded up to that time, so a run can be
 * reproduced while the sampler keeps writing. Without it, everything so far.
 */
function parseArgs(argv: string[]): { modelPath: string | undefined; until: Date } {
  const i = argv.indexOf("--until");
  const until = i > -1 ? new Date(argv[i + 1]) : new Date();
  if (Number.isNaN(until.getTime())) throw new Error(`--until needs an ISO timestamp, got "${argv[i + 1]}"`);
  const modelPath = argv.find((a, j) => !a.startsWith("--") && (i === -1 || j !== i + 1));
  return { modelPath, until };
}
const ARGS = parseArgs(process.argv.slice(2));

function loadModel(): { model: CostModel; file: string } {
  const schema = JSON.parse(fs.readFileSync("models/cost-model.schema.json", "utf8"));
  const candidates = [ARGS.modelPath, "models/cost-model.json", "models/cost-model.example.json"].filter(Boolean) as string[];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) throw new Error("no cost model artifact found");
  const result = validateCostModel(JSON.parse(fs.readFileSync(file, "utf8")), schema);
  if (!result.ok || !result.model) throw new Error(`${file} fails validation: ${result.errors.slice(0, 5).join("; ")}`);
  return { model: result.model, file };
}

// ---------- recorded data ----------

type Rung = { notional: number; impact: number; price: number };
type Ladder = { id: string; pair: string; t: number; rungs: Map<number, Rung> };
type DriftPath = { points: [number, number][] }; // [seconds, signed bps], starting [0, 0]

async function loadData(until: Date) {
  const db = new PrismaClient();
  try {
    const samples = (await db.$queryRaw`
      SELECT "ladderId", pair, "ladderRung" AS rung, "sampledAt", "notionalUsd"::float8 AS notional,
             "measuredImpactBps"::float8 AS impact, "effectivePrice"::float8 AS price, id
        FROM "QuoteSample"
       WHERE "sampledAt" <= ${until}`) as {
      ladderId: string; pair: string; rung: number; sampledAt: Date; notional: number | null; impact: number | null; price: number; id: string;
    }[];
    const drifts = (await db.$queryRaw`
      SELECT d."originSampleId" AS origin, d."actualElapsedMs" AS elapsed, d."driftBps"::float8 AS drift, s."ladderId", s."ladderRung" AS rung
        FROM "QuoteDrift" d JOIN "QuoteSample" s ON s.id = d."originSampleId"
       WHERE d."requotedAt" <= ${until}`) as {
      origin: string; elapsed: number; drift: number; ladderId: string; rung: number;
    }[];
    return { samples, drifts };
  } finally {
    await db.$disconnect();
  }
}

function buildIndex(samples: Awaited<ReturnType<typeof loadData>>["samples"], drifts: Awaited<ReturnType<typeof loadData>>["drifts"]) {
  const ladders = new Map<string, Ladder>();
  for (const s of samples) {
    let l = ladders.get(s.ladderId);
    if (!l) ladders.set(s.ladderId, (l = { id: s.ladderId, pair: s.pair, t: s.sampledAt.getTime(), rungs: new Map() }));
    l.t = Math.min(l.t, s.sampledAt.getTime());
    if (s.notional !== null) l.rungs.set(s.rung, { notional: s.notional, impact: s.rung === 1 ? 0 : s.impact ?? NaN, price: s.price });
  }

  const byPair = new Map<string, Ladder[]>();
  for (const l of ladders.values()) (byPair.get(l.pair) ?? byPair.set(l.pair, []).get(l.pair)!).push(l);
  for (const list of byPair.values()) list.sort((a, b) => a.t - b.t);

  // Drift path per ladder, from its small (rung 2) origin, on-time rows only.
  const paths = new Map<string, DriftPath>();
  const grouped = new Map<string, Map<number, number>>();
  for (const d of drifts) {
    if (d.rung !== 2) continue;
    const h = assignHorizon(d.elapsed);
    if (h === null) continue;
    (grouped.get(d.ladderId) ?? grouped.set(d.ladderId, new Map()).get(d.ladderId)!).set(h, d.drift);
  }
  for (const [ladderId, byH] of grouped) {
    if (!byH.has(5)) continue;
    const pts: [number, number][] = [[0, 0], ...[...byH.entries()].sort((a, b) => a[0] - b[0])];
    paths.set(ladderId, { points: pts });
  }

  const priceSeries = new Map<string, PricePoint[]>();
  for (const [pair, list] of byPair) {
    priceSeries.set(pair, list.filter((l) => l.rungs.get(1)).map((l) => ({ t: l.t, price: l.rungs.get(1)!.price })));
  }
  return { byPair, paths, priceSeries };
}

/** Recorded impact at notional x from one ladder: linear in log10(notional) between rungs. */
function curveAt(ladder: Ladder): (x: number) => number {
  const pts = [...ladder.rungs.entries()]
    .filter(([r, v]) => r >= 1 && Number.isFinite(v.impact))
    .map(([, v]) => [Math.log10(v.notional), v.impact] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  return (x: number) => {
    if (x <= 0 || pts.length === 0) return 0;
    const lx = Math.log10(x);
    if (lx <= pts[0][0]) return 0; // at or below the ~$25 baseline rung
    for (let i = 1; i < pts.length; i++) {
      if (lx <= pts[i][0]) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        return y0 + ((lx - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    // Beyond the top rung: continue the last segment. Orders never need it;
    // their cumulative size is at most their own rung.
    const [x0, y0] = pts[pts.length - 2] ?? pts[0];
    const [x1, y1] = pts[pts.length - 1];
    return x1 === x0 ? y1 : y1 + ((lx - x1) / (x1 - x0)) * (y1 - y0);
  };
}

// ---------- realised costs ----------

type Realised = { bps: number; failed: boolean; fees: number; approximate: boolean };

function makeWorld(origin: Ladder, ladders: Ladder[], driftPath: DriftPath, latency: number, feeUsd: number, notional: number) {
  const feeBps = (feeUsd / notional) * 10_000;
  const p1 = origin.rungs.get(1)!.price;
  const last = driftPath.points[driftPath.points.length - 1];

  const nearestLadder = (tMs: number): Ladder | null => {
    let best: Ladder | null = null;
    for (const l of ladders) {
      if (Math.abs(l.t - tMs) <= LADDER_MATCH_MS && (!best || Math.abs(l.t - tMs) < Math.abs(best.t - tMs))) best = l;
    }
    return best;
  };

  let approximate = false;
  /** Recorded signed drift (bps, positive = worse) from the origin quote to t seconds later. */
  const pathAt = (t: number): number => {
    if (t <= last[0]) {
      const pts = driftPath.points;
      for (let i = 1; i < pts.length; i++) {
        if (t <= pts[i][0]) {
          const [t0, d0] = pts[i - 1];
          const [t1, d1] = pts[i];
          return d0 + ((t - t0) / (t1 - t0)) * (d1 - d0);
        }
      }
    }
    const l = nearestLadder(origin.t + t * 1000);
    const r1 = l?.rungs.get(1);
    if (!r1) {
      approximate = true;
      return last[1];
    }
    return ((p1 - r1.price) / p1) * 10_000;
  };
  const execAt = (t: number) => pathAt(t + latency) - pathAt(t);

  // Where a failed order gets completed: the next recorded ladder of the pair,
  // between 1 and 10 minutes later.
  const next = ladders.find((l) => l.t > origin.t + 60_000 && l.t <= origin.t + 600_000 && l.rungs.get(1));
  /**
   * Cost, in bps of the whole order, of filling sizeUsd of it at the next
   * ladder, on top of displacedUsd of our own earlier fills that the pool has
   * not recovered from (0 when nothing of ours traded).
   */
  const completion = (sizeUsd: number, displacedUsd = 0): number => {
    if (!next) approximate = true;
    const I = next ? curveAt(next) : curveAt(origin);
    const wait = next ? ((p1 - next.rungs.get(1)!.price) / p1) * 10_000 : last[1];
    const total = displacedUsd + sizeUsd;
    const impactUsdBps = total * I(total) - (displacedUsd > 0 ? displacedUsd * I(displacedUsd) : 0);
    return (sizeUsd * wait + impactUsdBps) / notional + feeBps;
  };
  const curveFor = (t: number) => curveAt(t <= 60 ? origin : nearestLadder(origin.t + t * 1000) ?? origin);

  const sendNow = (cap: number): Realised => {
    const e = execAt(0);
    if (e > cap) return { bps: feeBps + completion(notional), failed: true, fees: 2, approximate };
    return { bps: curveAt(origin)(notional) + e + feeBps, failed: false, fees: 1, approximate };
  };

  // Failed portions are completed together at the next ladder, on top of the
  // displacement our filled portions leave, decayed one more step by rho: at
  // rho = 0 a pool that never recovers is still displaced when we come back.
  // (Completing them on a fresh pool let failures dodge the rho = 0 penalty.)
  const split = (k: number, windowSeconds: number, rho: number, cap: number): Realised => {
    const portion = notional / k;
    let displaced = 0;
    let bps = 0;
    let failedPortions = 0;
    for (const t of portionDelays(k, windowSeconds)) {
      const e = execAt(t);
      if (e > cap) {
        failedPortions += 1;
        bps += feeBps;
        continue;
      }
      const I = curveFor(t);
      const size = displaced + portion;
      const impactUsdBps = size * I(size) - (displaced > 0 ? displaced * I(displaced) : 0);
      bps += impactUsdBps / notional + (pathAt(t) + e) / k + feeBps;
      displaced = (1 - rho) * size;
    }
    if (failedPortions > 0) {
      // One completion per failed portion in fees, priced as one block.
      bps += completion(failedPortions * portion, displaced) + (failedPortions - 1) * feeBps;
    }
    return { bps, failed: failedPortions > 0, fees: k + failedPortions, approximate };
  };

  // Each attempt is a fresh quote at the start of the next RECORDED window of
  // the drift path (0-5 s, then 5-15 s, then 15-30 s) and fills if the
  // recorded move over that window stays within the tightened cap. A rejected
  // attempt's move is still paid: the retry starts from the moved price.
  // Later windows are longer than one latency, which overstates retry drift.
  // A window the path did not record is not invented: the order stops
  // retrying there, is completed at the next ladder, and is flagged
  // approximate. (Interpolating the path made attempts 2 and 3 identical
  // halves of the 5-15 s move.)
  const tighten = (cap: number, retries: number): Realised => {
    const pts = driftPath.points;
    let attempts = 0;
    for (let i = 0; i < retries; i++) {
      if (i + 1 >= pts.length) {
        approximate = true;
        break;
      }
      attempts += 1;
      const [, start] = pts[i];
      const [, end] = pts[i + 1];
      if (end - start <= cap) return { bps: curveAt(origin)(notional) + end + attempts * feeBps, failed: false, fees: attempts, approximate };
    }
    return { bps: attempts * feeBps + completion(notional), failed: true, fees: attempts + 1, approximate };
  };

  const realise = (c: Candidate, cap: number, rho: number): Realised => {
    if (c.mode === "SEND_NOW") return sendNow(cap);
    if (c.mode === "SPLIT") return split(c.params.k!, c.params.windowSeconds!, rho, cap);
    return tighten(c.params.capBps!, c.params.retries!);
  };

  return { sendNow, split, tighten, realise, pathAt, curveAt: () => curveAt(origin), feeBps };
}

/**
 * A deferred plan, executed as planned at the next ladder of the pair that
 * has a recorded drift path (within 10 minutes), plus the recorded price
 * change while waiting. With no such ladder it falls back to executing now,
 * flagged approximate.
 */
function realiseDeferred(
  plan: Candidate, origin: Ladder, ladders: Ladder[], paths: Map<string, DriftPath>,
  latency: number, feeUsd: number, notional: number, cap: number, rho: number,
): Realised {
  const next = ladders.find((l) => l.t > origin.t + 60_000 && l.t <= origin.t + 600_000 && paths.has(l.id) && l.rungs.get(1));
  if (!next) {
    const now = makeWorld(origin, ladders, paths.get(origin.id)!, latency, feeUsd, notional).realise(plan, cap, rho);
    return { ...now, approximate: true };
  }
  const p0 = origin.rungs.get(1)!.price;
  const wait = ((p0 - next.rungs.get(1)!.price) / p0) * 10_000;
  const later = makeWorld(next, ladders, paths.get(next.id)!, latency, feeUsd, notional).realise(plan, cap, rho);
  return { ...later, bps: later.bps + wait };
}

// ---------- statistics ----------

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (xs: number[], p: number) => (xs.length ? quantileSorted([...xs].sort((a, b) => a - b), p) : NaN);
const r2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

const BOOTSTRAP_BLOCK_MINUTES = 30;
const BOOTSTRAP_RESAMPLES = 5000;

/**
 * 95% interval for a mean, by block bootstrap: observations are grouped into
 * 30-minute blocks of order time and whole blocks are resampled, because
 * orders close in time share a market and are not independent. Seeded, so a
 * re-run on the same data gives the same interval.
 */
function blockBootstrapMeanCI(items: { t: number; x: number }[]): { lo: number | null; hi: number | null; blocks: number } {
  const byBlock = new Map<number, number[]>();
  for (const { t, x } of items) {
    const k = Math.floor(t / (BOOTSTRAP_BLOCK_MINUTES * 60_000));
    if (!byBlock.has(k)) byBlock.set(k, []);
    byBlock.get(k)!.push(x);
  }
  const blocks = [...byBlock.values()];
  if (blocks.length < 2) return { lo: null, hi: null, blocks: blocks.length };
  let seed = 20261016;
  const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const means: number[] = [];
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    let sum = 0, n = 0;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[Math.floor(next() * blocks.length)];
      for (const x of block) sum += x;
      n += block.length;
    }
    means.push(sum / n);
  }
  return { lo: r2(pct(means, 0.025)), hi: r2(pct(means, 0.975)), blocks: blocks.length };
}

// ---------- charts (SVG, no dependencies) ----------

function svgLineChart(title: string, xLabel: string, yLabel: string, series: { name: string; colour: string; points: [number, number][] }[]) {
  const W = 760, H = 760, L = 70, R = 170, T = 40, B = 55;
  const xs = series.flatMap((s) => s.points.map((p) => p[0]));
  const ys = series.flatMap((s) => s.points.map((p) => p[1])).filter(Number.isFinite);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(0, ...ys), Math.max(0, ...ys)];
  if (y0 === y1) y1 = y0 + 1;
  const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
  const X = (x: number) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R);
  const Y = (y: number) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const ticks = Array.from({ length: 6 }, (_, i) => y0 + ((y1 - y0) * i) / 5);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Helvetica,Arial,sans-serif" font-size="12"><rect width="100%" height="100%" fill="white"/>`;
  s += `<text x="${W / 2 - R / 2}" y="22" text-anchor="middle" font-size="14" font-weight="bold">${title}</text>`;
  for (const t of ticks) s += `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" stroke="#eee"/><text x="${L - 6}" y="${Y(t) + 4}" text-anchor="end">${t.toFixed(1)}</text>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" stroke="#999"/>`;
  for (const p of series[0]?.points ?? []) s += `<text x="${X(p[0])}" y="${H - B + 18}" text-anchor="middle">${p[0]}</text>`;
  s += `<text x="${(L + W - R) / 2}" y="${H - 12}" text-anchor="middle">${xLabel}</text>`;
  s += `<text transform="translate(16,${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">${yLabel}</text>`;
  series.forEach((ser, i) => {
    const pts = ser.points.filter((p) => Number.isFinite(p[1]));
    s += `<polyline fill="none" stroke="${ser.colour}" stroke-width="2" points="${pts.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}"/>`;
    for (const p of pts) s += `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="3" fill="${ser.colour}"/>`;
    s += `<rect x="${W - R + 12}" y="${T + i * 20}" width="12" height="3" fill="${ser.colour}"/><text x="${W - R + 30}" y="${T + i * 20 + 5}">${ser.name}</text>`;
  });
  return s + "</svg>\n";
}

function svgHistogram(title: string, xLabel: string, groups: { name: string; colour: string; values: number[] }[], bins = 30) {
  const all = groups.flatMap((g) => g.values).filter(Number.isFinite);
  const lo = pct(all, 0.01), hi = pct(all, 0.99);
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + ((hi - lo) * i) / bins);
  const counts = groups.map((g) => {
    const c = new Array(bins).fill(0);
    for (const v of g.values) c[Math.min(bins - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo || 1)) * bins)))]++;
    return c.map((x) => x / Math.max(1, g.values.length));
  });
  const W = 760, H = 760, L = 60, R = 200, T = 40, B = 55;
  const maxC = Math.max(...counts.flat(), 0.001);
  const X = (x: number) => L + ((x - lo) / (hi - lo || 1)) * (W - L - R);
  const Y = (y: number) => T + (1 - y / maxC) * (H - T - B);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Helvetica,Arial,sans-serif" font-size="12"><rect width="100%" height="100%" fill="white"/>`;
  s += `<text x="${W / 2 - R / 2}" y="22" text-anchor="middle" font-size="14" font-weight="bold">${title}</text>`;
  groups.forEach((g, gi) => {
    counts[gi].forEach((c, i) => {
      s += `<rect x="${X(edges[i])}" y="${Y(c)}" width="${Math.max(1, X(edges[i + 1]) - X(edges[i]) - 1)}" height="${Y(0) - Y(c)}" fill="${g.colour}" fill-opacity="0.45"/>`;
    });
    s += `<rect x="${W - R + 12}" y="${T + gi * 20 - 8}" width="12" height="12" fill="${g.colour}" fill-opacity="0.6"/><text x="${W - R + 30}" y="${T + gi * 20 + 2}">${g.name} (n=${g.values.length})</text>`;
  });
  if (lo < 0 && hi > 0) s += `<line x1="${X(0)}" x2="${X(0)}" y1="${T}" y2="${H - B}" stroke="#444" stroke-dasharray="4,3"/>`;
  for (let i = 0; i <= 5; i++) { const v = lo + ((hi - lo) * i) / 5; s += `<text x="${X(v)}" y="${H - B + 18}" text-anchor="middle">${v.toFixed(1)}</text>`; }
  s += `<text x="${(L + W - R) / 2}" y="${H - 12}" text-anchor="middle">${xLabel}</text>`;
  return s + "</svg>\n";
}

function toPng(svgFile: string) {
  try {
    execFileSync("qlmanage", ["-t", "-s", "1440", "-o", path.dirname(svgFile), svgFile], { stdio: "ignore" });
    const made = `${svgFile}.png`;
    if (fs.existsSync(made)) fs.renameSync(made, svgFile.replace(/\.svg$/, ".png"));
  } catch {
    // Not macOS, or Quick Look unavailable: the SVG is the chart.
  }
}

// ---------- main ----------

type Row = Record<string, string | number | boolean | null>;

type Order = {
  id: string; pair: string; depth: string; notional: number; bucket: string; t: number; volatility: number | null;
  control: Realised;
  fixed: Record<number, Realised>;
  /** The shipped advisor (DEFER off) assuming rho, realised in a world where rho is true. */
  advisor: Record<number, { advice: Advice; realised: Realised }>;
  /** The regret 2x2: what each assumed rho's plan cost in each true rho. */
  regret: { a1t1: Realised; a1t0: Realised; a0t1: Realised; a0t0: Realised };
  /** DEFER switched on, at rho = 1: the deferred plan and the same plan done at once. */
  deferExperiment: { deferred: Realised; immediate: Realised } | null;
  breakevenRho: number | "never" | null;
};

type Data = Awaited<ReturnType<typeof loadData>>;

function runCap(cap: number, model: CostModel, index: ReturnType<typeof buildIndex>) {
  const { byPair, paths, priceSeries } = index;
  const cutoff = Date.parse(model.split.cutoff);
  const latency = DEFAULT_ADVISOR_PARAMS.latencySeconds;
  const feeUsd = DEFAULT_ADVISOR_PARAMS.feeUsd;
  const orders: Order[] = [];

  for (const [pair, ladders] of byPair) {
    const series = priceSeries.get(pair) ?? [];
    for (const ladder of ladders) {
      if (ladder.t < cutoff) continue;
      const dp = paths.get(ladder.id);
      if (!dp || !ladder.rungs.get(1)) continue;

      const volatility = realisedVolatility(series, ladder.t - 1); // strictly before this ladder
      for (let rung = 2; rung <= 8; rung++) {
        const r = ladder.rungs.get(rung);
        if (!r || !Number.isFinite(r.impact)) continue;
        const notional = r.notional;
        const world = makeWorld(ladder, ladders, dp, latency, feeUsd, notional);
        const control = world.sendNow(cap);
        const fixed: Order["fixed"] = {};
        const advisor: Order["advisor"] = {};

        for (const rho of RHOS) {
          const advice = advise(model, { pair, notionalUsd: notional, capBps: cap, volatility }, { ...DEFAULT_ADVISOR_PARAMS, recoveryFraction: rho });
          advisor[rho] = { advice, realised: world.realise(advice.best, cap, rho) };
          fixed[rho] = world.split(FIXED_SPLIT.k, FIXED_SPLIT.windowSeconds, rho, cap);
        }

        const regret = {
          a1t1: advisor[1].realised,
          a1t0: world.realise(advisor[1].advice.best, cap, 0),
          a0t1: world.realise(advisor[0].advice.best, cap, 1),
          a0t0: advisor[0].realised,
        };

        const withDefer = advise(model, { pair, notionalUsd: notional, capBps: cap, volatility }, { ...DEFAULT_ADVISOR_PARAMS, deferEnabled: true });
        const deferExperiment =
          withDefer.mode === "DEFER"
            ? {
                deferred: realiseDeferred(withDefer.best, ladder, ladders, paths, latency, feeUsd, notional, cap, 1),
                immediate: world.realise(withDefer.best, cap, 1),
              }
            : null;

        // Breakeven recovery: the smallest rho at which the advisor's SPLIT plan
        // pays for itself. Its saving on the RECORDED impact curve has to cover
        // its extra fees and its predicted waiting-drift risk, which is the
        // trade the advisor makes. Realised drift is left out on purpose: at
        // rho = 0 it decides "beats SEND_NOW" by luck, which says nothing about
        // recovery.
        const plan = advisor[1].advice.byMode.SPLIT;
        const curve = world.curveAt();
        const k = plan.params.k!;
        const sendCost = curve(notional) + world.feeBps;
        const f = (rho: number) => splitImpactBps(curve, notional, k, rho) + k * world.feeBps + plan.cost.waitingDriftBps - sendCost;
        let breakevenRho: Order["breakevenRho"];
        if (f(1) >= 0) breakevenRho = "never";
        else if (f(0) < 0) breakevenRho = 0;
        else {
          let lo = 0, hi = 1;
          for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (f(mid) < 0) hi = mid; else lo = mid; }
          breakevenRho = (lo + hi) / 2;
        }

        orders.push({
          id: `${ladder.id}:${rung}`, pair, depth: depthOf(pair), notional, bucket: sizeBucket(notional), t: ladder.t, volatility,
          control, fixed, advisor, regret, deferExperiment, breakevenRho,
        });
      }
    }
  }

  if (!orders.length) throw new Error("no held-out orders: is there drift data after the cutoff?");
  return orders;
}

const saved = (o: Order, r: Realised) => o.control.bps - r.bps;
const worseThanControl = (o: Order, r: Realised) => r.bps > o.control.bps + 1e-9;

function summariseCap(cap: number, orders: Order[]) {
  const feeUsd = DEFAULT_ADVISOR_PARAMS.feeUsd;
  const depths = ["deep", "thin"] as const;

  const byDepthRho: Record<string, Record<string, Row & Record<string, unknown>>> = {};
  for (const d of depths) {
    byDepthRho[d] = {};
    const os = orders.filter((o) => o.depth === d);
    if (!os.length) continue;
    for (const rho of RHOS) {
      const s = os.map((o) => saved(o, o.advisor[rho].realised));
      const worse = os.filter((o) => worseThanControl(o, o.advisor[rho].realised)).length;
      byDepthRho[d][rho.toFixed(1)] = {
        n: os.length,
        meanSaved: r2(mean(s)), medianSaved: r2(pct(s, 0.5)), p5Saved: r2(pct(s, 0.05)), p25Saved: r2(pct(s, 0.25)), p75Saved: r2(pct(s, 0.75)), p95Saved: r2(pct(s, 0.95)),
        fixedSplitMeanSaved: r2(mean(os.map((o) => saved(o, o.fixed[rho])))), fixedSplitMedianSaved: r2(pct(os.map((o) => saved(o, o.fixed[rho])), 0.5)),
        worseThanControl: worse, worseThanControlShare: r2(worse / os.length),
        failControl: r2(os.filter((o) => o.control.failed).length / os.length),
        failAdvisor: r2(os.filter((o) => o.advisor[rho].realised.failed).length / os.length),
        failFixedSplit: r2(os.filter((o) => o.fixed[rho].failed).length / os.length),
        feesControlUsd: r2(os.reduce((a, o) => a + o.control.fees * feeUsd, 0)),
        feesAdvisorUsd: r2(os.reduce((a, o) => a + o.advisor[rho].realised.fees * feeUsd, 0)),
        feesFixedSplitUsd: r2(os.reduce((a, o) => a + o.fixed[rho].fees * feeUsd, 0)),
        modes: Object.entries(countBy(os, (o) => o.advisor[rho].advice.mode)).map(([m, c]) => `${m} ${c}`).join(", "),
        lowConfidenceShare: r2(os.filter((o) => o.advisor[rho].advice.lowConfidence).length / os.length),
      };
    }
  }

  // Per size: the bracket, the breakeven, the flip, low confidence.
  const bySize: Row[] = [];
  // The regret 2x2 per size.
  const regret: Row[] = [];
  for (const d of depths) {
    for (const [bucket] of SIZE_BUCKETS) {
      const os = orders.filter((o) => o.depth === d && o.bucket === bucket);
      if (!os.length) continue;
      const be = os.map((o) => o.breakevenRho);
      const numeric = be.filter((x): x is number => typeof x === "number");
      bySize.push({
        depth: d, size: bucket, n: os.length,
        controlMedianBps: r2(pct(os.map((o) => o.control.bps), 0.5)),
        savedMedianRho1: r2(pct(os.map((o) => saved(o, o.advisor[1].realised)), 0.5)),
        savedMedianRho0: r2(pct(os.map((o) => saved(o, o.advisor[0].realised)), 0.5)),
        breakevenRhoMedian: numeric.length ? Math.round(pct(numeric, 0.5) * 1000) / 1000 : null,
        splitNeverPays: be.filter((x) => x === "never").length,
        modesRho1: Object.entries(countBy(os, (o) => o.advisor[1].advice.mode)).map(([m, c]) => `${m}:${c}`).join(" "),
        modesRho0: Object.entries(countBy(os, (o) => o.advisor[0].advice.mode)).map(([m, c]) => `${m}:${c}`).join(" "),
        choiceFlips: os.filter((o) => o.advisor[1].advice.mode !== o.advisor[0].advice.mode).length,
        worseThanControlRho1: os.filter((o) => worseThanControl(o, o.advisor[1].realised)).length,
        lowConfidence: os.filter((o) => o.advisor[1].advice.lowConfidence).length,
      });

      const cell = (pick: (o: Order) => Realised) => {
        const s = os.map((o) => saved(o, pick(o)));
        return { median: r2(pct(s, 0.5)), mean: r2(mean(s)), p5: r2(pct(s, 0.05)) };
      };
      const a1t1 = cell((o) => o.regret.a1t1), a1t0 = cell((o) => o.regret.a1t0), a0t1 = cell((o) => o.regret.a0t1), a0t0 = cell((o) => o.regret.a0t0);
      regret.push({
        depth: d, size: bucket, n: os.length,
        assume1_true1_medianSaved: a1t1.median, assume1_true1_meanSaved: a1t1.mean,
        assume1_true0_medianSaved: a1t0.median, assume1_true0_meanSaved: a1t0.mean, assume1_true0_p5Saved: a1t0.p5,
        assume0_true1_medianSaved: a0t1.median, assume0_true1_meanSaved: a0t1.mean,
        assume0_true0_medianSaved: a0t0.median, assume0_true0_meanSaved: a0t0.mean,
        forgoneMedianIfAssume0: r2((a1t1.median ?? 0) - (a0t1.median ?? 0)),
        plansDiffer: os.filter((o) => o.advisor[1].advice.mode !== o.advisor[0].advice.mode).length,
      });
    }
  }

  // Why the chosen plans are low confidence: the worst coverage among their
  // components, per depth and chosen mode, at rho = 1.
  const coverage: Row[] = [];
  for (const d of depths) {
    const os = orders.filter((o) => o.depth === d);
    for (const [mode, n] of Object.entries(countBy(os, (o) => o.advisor[1].advice.mode))) {
      const of = countBy(os.filter((o) => o.advisor[1].advice.mode === mode), (o) => o.advisor[1].advice.best.coverage);
      coverage.push({
        depth: d, mode, n,
        ok: of.ok ?? 0, sparse: of.sparse ?? 0, fallback: of.fallback ?? 0, extrapolated: of.extrapolated ?? 0, none: of.none ?? 0,
        lowConfidenceShare: r2((n - (of.ok ?? 0)) / n),
      });
    }
  }

  // TIGHTEN_AND_RETRY: how often chosen, and whether it beat the control.
  const tighten: Row[] = depths.map((d) => {
    const os = orders.filter((o) => o.depth === d && o.advisor[1].advice.mode === "TIGHTEN_AND_RETRY");
    const s = os.map((o) => saved(o, o.advisor[1].realised));
    const ci = blockBootstrapMeanCI(os.map((o, i) => ({ t: o.t, x: s[i] })));
    return {
      depth: d, chosen: os.length, ofOrders: orders.filter((o) => o.depth === d).length,
      medianSaved: r2(pct(s, 0.5)), meanSaved: r2(mean(s)),
      meanSavedCI: ci.lo === null ? null : `[${ci.lo}, ${ci.hi}] (${ci.blocks} blocks)`,
      beatControl: os.filter((o) => o.advisor[1].realised.bps < o.control.bps - 1e-9).length,
      worseThanControl: os.filter((o) => worseThanControl(o, o.advisor[1].realised)).length,
      failRate: r2(os.filter((o) => o.advisor[1].realised.failed).length / Math.max(1, os.length)),
      controlFailRateSameOrders: r2(os.filter((o) => o.control.failed).length / Math.max(1, os.length)),
    };
  });

  // DEFER experiment.
  const deferExperiment: Row[] = depths.map((d) => {
    const os = orders.filter((o) => o.depth === d && o.deferExperiment);
    const gain = os.map((o) => o.deferExperiment!.immediate.bps - o.deferExperiment!.deferred.bps);
    const ci = blockBootstrapMeanCI(os.map((o, i) => ({ t: o.t, x: gain[i] })));
    return {
      depth: d, deferred: os.length, deferringWasCheaper: gain.filter((g) => g > 0).length, deferringWasDearer: gain.filter((g) => g < 0).length,
      meanGainBps: r2(mean(gain)), meanGainCI: ci.lo === null ? null : `[${ci.lo}, ${ci.hi}] (${ci.blocks} blocks)`,
      medianGainBps: r2(pct(gain, 0.5)), worstBps: r2(Math.min(...gain)), bestBps: r2(Math.max(...gain)),
    };
  });

  // The regret verdict, for thin orders of $10k and up, where the plans differ.
  const big = orders.filter((o) => o.depth === "thin" && o.notional >= 5_000);
  const upside = big.map((o) => saved(o, o.regret.a1t1));
  const downside = big.map((o) => saved(o, o.regret.a1t0));
  const cell2x2 = (pick: (o: Order) => Realised) => {
    const s = big.map((o) => saved(o, pick(o)));
    return { median: r2(pct(s, 0.5)), mean: r2(mean(s)), worst5pct: r2(pct(s, 0.05)) };
  };
  const verdict = {
    population: "thin pairs, orders of about $10k and up",
    n: big.length,
    upsideMedianBps: r2(pct(upside, 0.5)),
    upsideMeanBps: r2(mean(upside)),
    downsideMedianBps: r2(pct(downside, 0.5)),
    downsideMeanBps: r2(mean(downside)),
    downsideWorst5pctBps: r2(pct(downside, 0.05)),
    // Saved bps vs always-SEND_NOW: advisor assumes rho (rows) x pool has rho (columns).
    twoByTwo: {
      assume1_true1: cell2x2((o) => o.regret.a1t1),
      assume1_true0: cell2x2((o) => o.regret.a1t0),
      assume0_true1: cell2x2((o) => o.regret.a0t1),
      assume0_true0: cell2x2((o) => o.regret.a0t0),
    },
  };

  return { cap, byDepthRho, bySize, regret, coverage, tighten, deferExperiment, verdict };
}

function writeCap(dir: string, cap: number, orders: Order[], summary: ReturnType<typeof summariseCap>, meta: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });

  const rows: Row[] = orders.map((o) => ({
    order: o.id, time: new Date(o.t).toISOString(), pair: o.pair, depth: o.depth, notionalUsd: r2(o.notional), size: o.bucket, capBps: cap,
    volatility: o.volatility === null ? null : r2(o.volatility),
    controlBps: r2(o.control.bps), controlFailed: o.control.failed,
    advisorModeRho1: o.advisor[1].advice.mode, advisorPlanRho1: JSON.stringify(o.advisor[1].advice.best.params),
    advisorPredictedBpsRho1: r2(o.advisor[1].advice.best.cost.totalBps), advisorRealisedBpsRho1: r2(o.advisor[1].realised.bps),
    advisorFailedRho1: o.advisor[1].realised.failed, savedRho1: r2(saved(o, o.advisor[1].realised)),
    advisorModeRho0: o.advisor[0].advice.mode, advisorRealisedBpsRho0: r2(o.advisor[0].realised.bps), savedRho0: r2(saved(o, o.advisor[0].realised)),
    regretAssume1True0Saved: r2(saved(o, o.regret.a1t0)), regretAssume0True1Saved: r2(saved(o, o.regret.a0t1)),
    choiceFlips: o.advisor[1].advice.mode !== o.advisor[0].advice.mode,
    fixedSplitBpsRho1: r2(o.fixed[1].bps), fixedSplitBpsRho0: r2(o.fixed[0].bps),
    breakevenRho: o.breakevenRho === "never" ? "never" : o.breakevenRho === null ? null : Math.round(o.breakevenRho * 1000) / 1000,
    deferExperimentGainBps: o.deferExperiment ? r2(o.deferExperiment.immediate.bps - o.deferExperiment.deferred.bps) : null,
    lowConfidence: o.advisor[1].advice.lowConfidence, coverage: o.advisor[1].advice.best.coverage,
    structuralShare: r2(o.advisor[1].advice.structuralShare), approximate: o.advisor[1].realised.approximate || o.control.approximate,
  }));
  const header = Object.keys(rows[0]);
  fs.writeFileSync(path.join(dir, "orders.csv"), [header.join(","), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(","))].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ ...meta, ...summary }, null, 2) + "\n");

  const colours = { deep: "#1f77b4", thin: "#ff7f0e" };
  const files: string[] = [];
  const write = (name: string, svg: string) => { const f = path.join(dir, name); fs.writeFileSync(f, svg); files.push(f); };
  write("saving_vs_recovery.svg", svgLineChart(
    `Cap ${cap} bps: advisor saving vs always-SEND_NOW, by pool recovery rho`,
    "recovery fraction rho (0 = none, 1 = full)",
    "bps saved (positive = advisor cheaper)",
    (["deep", "thin"] as const).filter((d) => summary.byDepthRho[d]["1.0"]).flatMap((d) => [
      { name: `${d} mean`, colour: colours[d], points: RHOS.map((rho) => [rho, Number(summary.byDepthRho[d][rho.toFixed(1)].meanSaved ?? NaN)] as [number, number]) },
      { name: `${d} median`, colour: d === "deep" ? "#7fb2e0" : "#ffbf80", points: RHOS.map((rho) => [rho, Number(summary.byDepthRho[d][rho.toFixed(1)].medianSaved ?? NaN)] as [number, number]) },
    ]),
  ));
  const palette = ["#fdd0a2", "#fdae6b", "#fd8d3c", "#e6550d", "#a63603", "#7f2704", "#4a1500"];
  write("saving_share_by_size.svg", svgLineChart(
    `Cap ${cap} bps, thin pairs: median saving as % of SEND_NOW cost`,
    "recovery fraction rho (0 = none, 1 = full)",
    "median % of SEND_NOW cost saved",
    SIZE_BUCKETS.map(([bucket], i) => {
      const os = orders.filter((o) => o.depth === "thin" && o.bucket === bucket && o.control.bps > 0);
      return { name: `${bucket} (n=${os.length})`, colour: palette[i], points: RHOS.map((rho) => [rho, 100 * pct(os.map((o) => saved(o, o.advisor[rho].realised) / o.control.bps), 0.5)] as [number, number]) };
    }).filter((x) => !x.name.endsWith("(n=0)")),
  ));
  write("saving_distribution_thin.svg", svgHistogram(
    `Cap ${cap} bps: bps saved per order, thin pairs`,
    "bps saved vs always-SEND_NOW",
    [
      { name: "rho = 1", colour: "#ff7f0e", values: orders.filter((o) => o.depth === "thin").map((o) => saved(o, o.advisor[1].realised)) },
      { name: "rho = 0", colour: "#8c564b", values: orders.filter((o) => o.depth === "thin").map((o) => saved(o, o.advisor[0].realised)) },
    ],
  ));
  write("saving_distribution_deep.svg", svgHistogram(
    `Cap ${cap} bps: bps saved per order, deep pairs`,
    "bps saved vs always-SEND_NOW",
    [
      { name: "rho = 1", colour: "#1f77b4", values: orders.filter((o) => o.depth === "deep").map((o) => saved(o, o.advisor[1].realised)) },
      { name: "rho = 0", colour: "#17becf", values: orders.filter((o) => o.depth === "deep").map((o) => saved(o, o.advisor[0].realised)) },
    ],
  ));
  for (const f of files) toPng(f);
}

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function table(rows: Row[], columns: [string, string][]): string[] {
  return [
    `| ${columns.map(([, h]) => h).join(" | ")} |`,
    `|${columns.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${columns.map(([k]) => (r[k] === null || r[k] === undefined ? "-" : String(r[k]))).join(" | ")} |`),
  ];
}

function report(meta: { modelVersion: string; producer: string; exampleOnly: boolean; trainCutoff: string; dataUntil: string; from: string; to: string; orders: number }, caps: ReturnType<typeof summariseCap>[]): string {
  const L: string[] = [];
  L.push("# Backtest: execution-mode advisor on held-out mainnet quotes", "");
  L.push(`- **Artifact:** \`${meta.modelVersion}\` (${meta.producer})${meta.exampleOnly ? " — **EXAMPLE ARTIFACT, not the Colab model; re-run for the headline**" : ""}`);
  L.push(`- Trained before ${meta.trainCutoff}. Held-out orders ${meta.from} .. ${meta.to}: **${meta.orders} orders per cap**, deep and thin pairs, ~$100 to ~$1M. Data up to ${meta.dataUntil}; reproduce with \`npm run backtest -- ${meta.exampleOnly ? "models/cost-model.example.json " : ""}--until ${meta.dataUntil}\`.`);
  L.push(`- Shipped advisor: DEFER off, fee $${DEFAULT_ADVISOR_PARAMS.feeUsd}/tx, latency ${DEFAULT_ADVISOR_PARAMS.latencySeconds} s, min ${DEFAULT_ADVISOR_PARAMS.minPortionIntervalSeconds} s between portions. Control: always SEND_NOW. Fixed baseline: ${FIXED_SPLIT.k} portions over ${FIXED_SPLIT.windowSeconds} s.`);
  L.push(`- Realised costs are read from recorded quotes; pool recovery rho is unmeasured and swept over [0, 1].`, "");

  for (const c of caps) {
    L.push(`## Cap ${c.cap} bps`, "");
    L.push(`### The recovery bracket`, "");
    const rowsBracket: Row[] = [];
    for (const d of ["deep", "thin"]) for (const rho of ["1.0", "0.5", "0.0"]) {
      const x = c.byDepthRho[d]?.[rho];
      if (x) rowsBracket.push({ depth: d, rho, ...x, worse: `${(100 * Number(x.worseThanControlShare)).toFixed(0)}% (${x.worseThanControl})`, fail: `${x.failControl} / ${x.failAdvisor} / ${x.failFixedSplit}`, fees: `${x.feesControlUsd} / ${x.feesAdvisorUsd} / ${x.feesFixedSplitUsd}`, lowConf: `${(100 * Number(x.lowConfidenceShare)).toFixed(0)}%` });
    }
    L.push(...table(rowsBracket, [["depth", "depth"], ["rho", "rho"], ["n", "n"], ["meanSaved", "mean saved bps"], ["medianSaved", "median"], ["p5Saved", "p5"], ["p95Saved", "p95"], ["worse", "advisor worse than control"], ["fail", "failure rate ctl / adv / fixed"], ["fees", "fees $ ctl / adv / fixed"], ["lowConf", "low confidence"], ["modes", "advisor modes"]]), "");

    L.push(`### Regret: the advisor assumes one rho and the pool has another`, "");
    L.push(`Saved bps vs always-SEND_NOW (median, n per row). "assume 1, true 0" is the cost of splitting when the pool never recovers.`, "");
    L.push(...table(c.regret, [["depth", "depth"], ["size", "size"], ["n", "n"], ["assume1_true1_medianSaved", "assume 1, true 1"], ["assume1_true0_medianSaved", "assume 1, true 0"], ["assume1_true0_p5Saved", "assume 1, true 0 (worst 5%)"], ["assume0_true1_medianSaved", "assume 0, true 1"], ["assume0_true0_medianSaved", "assume 0, true 0"], ["forgoneMedianIfAssume0", "forgone by assuming 0"], ["plansDiffer", "plans differ"]]), "");
    const v = c.verdict;
    const c2 = (x: { median: number | null; mean: number | null; worst5pct: number | null }) => `${x.median} (mean ${x.mean}, worst 5% ${x.worst5pct})`;
    L.push(`The 2x2 for ${v.population} (n=${v.n}), saved bps vs always-SEND_NOW, median (mean, worst 5%):`, "");
    L.push(
      "| advisor assumes | pool recovers fully (true rho = 1) | pool never recovers (true rho = 0) |",
      "|---|---|---|",
      `| rho = 1 (shipped) | ${c2(v.twoByTwo.assume1_true1)} | ${c2(v.twoByTwo.assume1_true0)} |`,
      `| rho = 0 | ${c2(v.twoByTwo.assume0_true1)} | ${c2(v.twoByTwo.assume0_true0)} |`,
      "",
    );
    L.push(`**Asymmetry (${v.population}, n=${v.n}):** assuming full recovery saves a median ${v.upsideMedianBps} bps (mean ${v.upsideMeanBps}) when it holds, and costs a median ${v.downsideMedianBps} bps (mean ${v.downsideMeanBps}, worst 5% ${v.downsideWorst5pctBps}) when the pool never recovers.`, "");

    L.push(`### Why plans are low confidence (rho = 1)`, "");
    L.push(
      "Each chosen plan carries the worst coverage among its parts. *sparse*: a cell with fewer than " +
        "`minConfidentN` observations. *fallback*: borrowed from the pooled depth class, the reversed pair, or a default volatility. " +
        "*extrapolated*: outside what was measured: a split whose portions wait longer than the longest measured drift horizon (60 s), " +
        "or an order or portion outside the sampled size range. More data at the same horizons cannot clear the first; only a longer drift horizon in the sampler can.",
      "",
    );
    L.push(...table(c.coverage, [["depth", "depth"], ["mode", "chosen mode"], ["n", "n"], ["ok", "ok"], ["sparse", "sparse"], ["fallback", "fallback"], ["extrapolated", "extrapolated"], ["none", "none"], ["lowConfidenceShare", "low confidence"]]), "");

    L.push(`### TIGHTEN_AND_RETRY`, "");
    L.push(...table(c.tighten, [["depth", "depth"], ["chosen", "chosen"], ["ofOrders", "of orders"], ["medianSaved", "median saved bps"], ["meanSaved", "mean saved"], ["meanSavedCI", "mean, 95% CI"], ["beatControl", "beat control"], ["worseThanControl", "worse than control"], ["failRate", "its failure rate"], ["controlFailRateSameOrders", "control failure rate, same orders"]]), "");

    L.push(`### DEFER, switched on as an experiment (off in the shipped advisor)`, "");
    L.push(...table(c.deferExperiment, [["depth", "depth"], ["deferred", "deferred"], ["deferringWasCheaper", "deferring was cheaper"], ["deferringWasDearer", "deferring was dearer"], ["meanGainBps", "mean gain bps"], ["meanGainCI", "mean, 95% CI"], ["medianGainBps", "median gain bps"], ["worstBps", "worst"], ["bestBps", "best"]]), "");

    L.push(`### By size`, "");
    L.push(...table(c.bySize, [["depth", "depth"], ["size", "size"], ["n", "n"], ["controlMedianBps", "control median bps"], ["savedMedianRho1", "saved median rho=1"], ["savedMedianRho0", "saved median rho=0"], ["breakevenRhoMedian", "breakeven rho"], ["splitNeverPays", "split never pays"], ["modesRho1", "modes rho=1"], ["modesRho0", "modes rho=0"], ["choiceFlips", "choice flips"], ["worseThanControlRho1", "worse than control"], ["lowConfidence", "low confidence"]]), "");
  }

  L.push("## Limitations", "");
  L.push(
    "- Recovery rho is unmeasured: the sampler never trades, so no recorded quote reflects our own fills.",
    "- TIGHTEN_AND_RETRY attempts use the drift path's recorded windows (0-5 s, 5-15 s, 15-30 s), so retries take 10-15 s rather than 5 s, which overstates retry drift. A window the path did not record ends the retries (flagged approximate).",
    "- Between recorded points the backtest interpolates: impact linearly in log-notional between a ladder's rungs (for split portions and completions), and drift linearly between the +5/15/30/60 s re-quotes (for split portions). Retries and single orders use recorded points only.",
    "- Drift beyond 60 s uses ladder-to-ladder rung-1 price changes, ladders every 90-120 s: coarse.",
    "- Orders are synthetic (one per recorded rung size on ladders with a recorded +5 s re-quote); every realised cost is read from recorded quotes.",
    "- A failed fill is completed at the pair's next recorded ladder (1-10 min later), paying the recorded waiting drift and that ladder's impact, so every strategy ends filled. Failed split portions are completed on top of the displacement our filled portions left, decayed one further rho step (exact at rho = 0 and 1, conservative between). Failure rates are reported separately.",
    "- Impact is naive on-chain execution through Jupiter's AMM routing.",
    `- Confidence intervals are block bootstraps (${BOOTSTRAP_BLOCK_MINUTES}-minute blocks of order time, ${BOOTSTRAP_RESAMPLES} resamples): orders close in time share a market. Few blocks make for wide, approximate intervals.`,
    ...(meta.exampleOnly ? ["- **Produced with the EXAMPLE artifact** (TypeScript reference fit), not the Colab cost model."] : []),
    "",
  );
  return L.join("\n");
}

async function main() {
  const { model, file } = loadModel();
  const isExample = /example/i.test(model.producer);
  console.log(`model ${model.modelVersion} (${model.producer}) from ${file}`);

  const data: Data = await loadData(ARGS.until);
  const index = buildIndex(data.samples, data.drifts);

  // Results from an earlier layout (one cap, files at the top level) are removed.
  for (const stale of ["orders.csv", "summary.json", "summary.md", "saving_vs_recovery.svg", "saving_vs_recovery.png", "saving_share_by_size.svg", "saving_share_by_size.png", "saving_distribution.svg", "saving_distribution.png", "saving_distribution_deep.svg", "saving_distribution_deep.png"]) {
    fs.rmSync(path.join(OUT, stale), { force: true });
  }

  const summaries: ReturnType<typeof summariseCap>[] = [];
  let meta = { modelVersion: model.modelVersion, producer: model.producer, exampleOnly: isExample, trainCutoff: model.split.cutoff, dataUntil: ARGS.until.toISOString(), from: "", to: "", orders: 0 };
  for (const cap of CAPS_BPS) {
    const orders = runCap(cap, model, index);
    const summary = summariseCap(cap, orders);
    meta = { ...meta, from: new Date(Math.min(...orders.map((o) => o.t))).toISOString(), to: new Date(Math.max(...orders.map((o) => o.t))).toISOString(), orders: orders.length };
    writeCap(path.join(OUT, `cap-${cap}bps`), cap, orders, summary, { artifact: { file, ...meta }, generatedAt: new Date().toISOString(), advisorParams: DEFAULT_ADVISOR_PARAMS });
    summaries.push(summary);
  }

  const md = report(meta, summaries);
  fs.writeFileSync(path.join(OUT, "README.md"), md);
  console.log(md);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}/README.md and ${CAPS_BPS.map((c) => `cap-${c}bps/`).join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
