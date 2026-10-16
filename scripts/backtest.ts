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
 *              its cap; it then pays its fee and the next cycle's adverse drift
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
  type AdvisorParams,
  type Candidate,
} from "../app/lib/advisor";
import { depthOf, validateCostModel, type CostModel } from "../app/lib/costModel";
import { assignHorizon, quantileSorted, realisedVolatility, type PricePoint } from "../app/lib/fillModel";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const { PrismaClient } = createRequire(import.meta.url)("../app/generated/prisma/index.js");

const OUT = path.resolve("reports/backtest");
const RHOS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const CAP_BPS = 50;
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

function loadModel(): { model: CostModel; file: string } {
  const schema = JSON.parse(fs.readFileSync("models/cost-model.schema.json", "utf8"));
  const candidates = [process.argv[2], "models/cost-model.json", "models/cost-model.example.json"].filter(Boolean) as string[];
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

async function loadData() {
  const db = new PrismaClient();
  try {
    const samples = (await db.$queryRaw`
      SELECT "ladderId", pair, "ladderRung" AS rung, "sampledAt", "notionalUsd"::float8 AS notional,
             "measuredImpactBps"::float8 AS impact, "effectivePrice"::float8 AS price, id
        FROM "QuoteSample"`) as {
      ladderId: string; pair: string; rung: number; sampledAt: Date; notional: number | null; impact: number | null; price: number; id: string;
    }[];
    const drifts = (await db.$queryRaw`
      SELECT d."originSampleId" AS origin, d."actualElapsedMs" AS elapsed, d."driftBps"::float8 AS drift, s."ladderId", s."ladderRung" AS rung
        FROM "QuoteDrift" d JOIN "QuoteSample" s ON s.id = d."originSampleId"`) as {
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
  const curveFor = (t: number) => curveAt(t <= 60 ? origin : nearestLadder(origin.t + t * 1000) ?? origin);

  const sendNow = (cap: number): Realised => {
    const e = execAt(0);
    if (e > cap) return { bps: feeBps + Math.max(0, execAt(latency)), failed: true, fees: 1, approximate };
    return { bps: curveAt(origin)(notional) + e + feeBps, failed: false, fees: 1, approximate };
  };

  const split = (k: number, windowSeconds: number, rho: number, cap: number): Realised => {
    const portion = notional / k;
    let displaced = 0;
    let bps = 0;
    let anyFailed = false;
    for (const t of portionDelays(k, windowSeconds)) {
      const e = execAt(t);
      if (e > cap) {
        anyFailed = true;
        bps += (feeBps + Math.max(0, execAt(t + latency))) / k;
        continue;
      }
      const I = curveFor(t);
      const size = displaced + portion;
      const impactUsdBps = size * I(size) - (displaced > 0 ? displaced * I(displaced) : 0);
      bps += impactUsdBps / notional + (pathAt(t) + e) / k + feeBps;
      displaced = (1 - rho) * size;
    }
    return { bps, failed: anyFailed, fees: k, approximate };
  };

  const tighten = (cap: number, retries: number): Realised => {
    for (let i = 0; i < retries; i++) {
      const t = i * latency;
      const e = execAt(t);
      if (e <= cap) return { bps: curveAt(origin)(notional) + pathAt(t) + e + (i + 1) * feeBps, failed: false, fees: i + 1, approximate };
    }
    return { bps: retries * feeBps + Math.max(0, pathAt(retries * latency)), failed: true, fees: retries, approximate };
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

async function main() {
  const { model, file } = loadModel();
  const cutoff = Date.parse(model.split.cutoff);
  const isExample = /example/i.test(model.producer);
  console.log(`model ${model.modelVersion} (${model.producer}) from ${file}`);
  console.log(`held-out period: on or after ${model.split.cutoff}`);

  const { samples, drifts } = await loadData();
  const { byPair, paths, priceSeries } = buildIndex(samples, drifts);
  const latency = DEFAULT_ADVISOR_PARAMS.latencySeconds;
  const feeUsd = DEFAULT_ADVISOR_PARAMS.feeUsd;

  type Row = Record<string, string | number | boolean | null>;
  const rows: Row[] = [];
  type Order = {
    id: string; pair: string; depth: string; notional: number; bucket: string; t: number; volatility: number | null;
    control: Realised; fixed: Record<number, Realised>;
    advisor: Record<number, { advice: Advice; realised: Realised; immediate: Realised | null }>;
    breakevenRho: number | "never" | null;
  };
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
        const control = world.sendNow(CAP_BPS);
        const fixed: Order["fixed"] = {};
        const advisor: Order["advisor"] = {};

        for (const rho of RHOS) {
          const params: AdvisorParams = { ...DEFAULT_ADVISOR_PARAMS, recoveryFraction: rho };
          const advice = advise(model, { pair, notionalUsd: notional, capBps: CAP_BPS, volatility }, params);
          const realised =
            advice.mode === "DEFER"
              ? realiseDeferred(advice.best, ladder, ladders, paths, latency, feeUsd, notional, CAP_BPS, rho)
              : world.realise(advice.best, CAP_BPS, rho);
          // For a deferral, also what the same plan would have cost done at once,
          // so the backtest can test DEFER instead of assuming it helps.
          const immediate = advice.mode === "DEFER" ? world.realise(advice.best, CAP_BPS, rho) : null;
          advisor[rho] = { advice, realised, immediate };
          fixed[rho] = world.split(FIXED_SPLIT.k, FIXED_SPLIT.windowSeconds, rho, CAP_BPS);
        }

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

        const id = `${ladder.id}:${rung}`;
        orders.push({ id, pair, depth: depthOf(pair), notional, bucket: sizeBucket(notional), t: ladder.t, volatility, control, fixed, advisor, breakevenRho });

        const a1 = advisor[1], a0 = advisor[0];
        rows.push({
          order: id, time: new Date(ladder.t).toISOString(), pair, depth: depthOf(pair), notionalUsd: r2(notional), sizeBucket: sizeBucket(notional),
          capBps: CAP_BPS, volatility: volatility === null ? null : r2(volatility),
          controlBps: r2(control.bps), controlFailed: control.failed,
          advisorModeRho1: a1.advice.mode, advisorPlanRho1: JSON.stringify(a1.advice.best.params), advisorPredictedBpsRho1: r2(a1.advice.best.cost.totalBps),
          advisorRealisedBpsRho1: r2(a1.realised.bps), advisorFailedRho1: a1.realised.failed, savedVsControlBpsRho1: r2(control.bps - a1.realised.bps),
          advisorModeRho0: a0.advice.mode, advisorPlanRho0: JSON.stringify(a0.advice.best.params),
          advisorRealisedBpsRho0: r2(a0.realised.bps), savedVsControlBpsRho0: r2(control.bps - a0.realised.bps),
          choiceFlips: a1.advice.mode !== a0.advice.mode,
          fixedSplitBpsRho1: r2(fixed[1].bps), fixedSplitBpsRho0: r2(fixed[0].bps),
          breakevenRho: breakevenRho === "never" ? "never" : breakevenRho === null ? null : Math.round(breakevenRho * 1000) / 1000,
          lowConfidence: a1.advice.lowConfidence, coverage: a1.advice.best.coverage,
          structuralShare: r2(a1.advice.structuralShare), approximate: a1.realised.approximate || control.approximate,
        });
      }
    }
  }

  if (!orders.length) throw new Error("no held-out orders: is there drift data after the cutoff?");

  // ---- summary ----
  const depths = ["deep", "thin"] as const;
  const summarise = (os: Order[], rho: number) => {
    const saved = os.map((o) => o.control.bps - o.advisor[rho].realised.bps);
    const savedFixed = os.map((o) => o.control.bps - o.fixed[rho].bps);
    const worse = os.filter((o) => o.advisor[rho].realised.bps > o.control.bps + 1e-9).length;
    const modes: Record<string, number> = {};
    for (const o of os) modes[o.advisor[rho].advice.mode] = (modes[o.advisor[rho].advice.mode] ?? 0) + 1;
    return {
      n: os.length,
      advisorSavedBps: { mean: r2(mean(saved)), median: r2(pct(saved, 0.5)), p5: r2(pct(saved, 0.05)), p25: r2(pct(saved, 0.25)), p75: r2(pct(saved, 0.75)), p95: r2(pct(saved, 0.95)) },
      fixedSplitSavedBps: { mean: r2(mean(savedFixed)), median: r2(pct(savedFixed, 0.5)) },
      fractionAdvisorWorseThanControl: r2(worse / os.length),
      advisorWorseThanControlCount: worse,
      failureRate: {
        control: r2(os.filter((o) => o.control.failed).length / os.length),
        advisor: r2(os.filter((o) => o.advisor[rho].realised.failed).length / os.length),
        fixedSplit: r2(os.filter((o) => o.fixed[rho].failed).length / os.length),
      },
      feeSpendUsd: {
        control: r2(os.reduce((s, o) => s + o.control.fees * feeUsd, 0)),
        advisor: r2(os.reduce((s, o) => s + o.advisor[rho].realised.fees * feeUsd, 0)),
        fixedSplit: r2(os.reduce((s, o) => s + o.fixed[rho].fees * feeUsd, 0)),
      },
      advisorModes: modes,
      lowConfidenceShare: r2(os.filter((o) => o.advisor[rho].advice.lowConfidence).length / os.length),
      deferCheck: (() => {
        const d = os.filter((o) => o.advisor[rho].immediate);
        const gain = d.map((o) => o.advisor[rho].immediate!.bps - o.advisor[rho].realised.bps);
        return { n: d.length, helped: gain.filter((g) => g > 0).length, meanGainBps: r2(mean(gain)), medianGainBps: r2(pct(gain, 0.5)) };
      })(),
    };
  };

  const byDepthRho: Record<string, Record<string, ReturnType<typeof summarise>>> = {};
  for (const d of depths) {
    byDepthRho[d] = {};
    const os = orders.filter((o) => o.depth === d);
    if (!os.length) continue;
    for (const rho of RHOS) byDepthRho[d][rho.toFixed(1)] = summarise(os, rho);
  }

  // Headline orders: per depth and size bucket, the bracket and the breakeven.
  const headline: Row[] = [];
  for (const d of depths) {
    for (const [bucket] of SIZE_BUCKETS) {
      const os = orders.filter((o) => o.depth === d && o.bucket === bucket);
      if (!os.length) continue;
      const be = os.map((o) => o.breakevenRho);
      const numeric = be.filter((x): x is number => typeof x === "number");
      const conf = os.filter((o) => !o.advisor[1].advice.lowConfidence).length;
      headline.push({
        depth: d, sizeBucket: bucket, n: os.length,
        controlMedianBps: r2(pct(os.map((o) => o.control.bps), 0.5)),
        savedMedianBpsRho1: r2(pct(os.map((o) => o.control.bps - o.advisor[1].realised.bps), 0.5)),
        savedMedianBpsRho0: r2(pct(os.map((o) => o.control.bps - o.advisor[0].realised.bps), 0.5)),
        savedMeanBpsRho1: r2(mean(os.map((o) => o.control.bps - o.advisor[1].realised.bps))),
        savedMeanBpsRho0: r2(mean(os.map((o) => o.control.bps - o.advisor[0].realised.bps))),
        breakevenRhoMedian: numeric.length ? Math.round(pct(numeric, 0.5) * 1000) / 1000 : null,
        splitNeverPays: be.filter((x) => x === "never").length,
        modeRho1: Object.entries(countBy(os, (o) => o.advisor[1].advice.mode)).map(([m, c]) => `${m}:${c}`).join(" "),
        modeRho0: Object.entries(countBy(os, (o) => o.advisor[0].advice.mode)).map(([m, c]) => `${m}:${c}`).join(" "),
        choiceFlips: os.filter((o) => o.advisor[1].advice.mode !== o.advisor[0].advice.mode).length,
        worseThanControlRho1: os.filter((o) => o.advisor[1].realised.bps > o.control.bps + 1e-9).length,
        lowConfidence: os.length - conf,
      });
    }
  }

  const summary = {
    artifact: { file, modelVersion: model.modelVersion, producer: model.producer, exampleOnly: isExample, trainCutoff: model.split.cutoff },
    generatedAt: new Date().toISOString(),
    heldOut: {
      from: new Date(Math.min(...orders.map((o) => o.t))).toISOString(),
      to: new Date(Math.max(...orders.map((o) => o.t))).toISOString(),
      orders: orders.length,
      ladders: new Set(orders.map((o) => o.id.split(":")[0])).size,
    },
    setup: { capBps: CAP_BPS, feeUsd, latencySeconds: latency, fixedSplit: FIXED_SPLIT, rhos: RHOS, advisorParams: DEFAULT_ADVISOR_PARAMS },
    byDepthRho,
    headline,
    limitations: [
      "Recovery rho is unmeasured: the sampler never trades, so no recorded quote reflects our own fills. Results are bracketed over rho in [0, 1].",
      "TIGHTEN_AND_RETRY retries are priced on recorded 5->15 s and 15->30 s moves: retry gaps of 10-15 s rather than 5 s, overstating retry drift.",
      "Drift beyond 60 s uses ladder-to-ladder rung-1 price changes, ladders every 90-120 s: coarse.",
      "Orders are synthetic (one per recorded rung size on ladders with a recorded +5 s re-quote); all realised costs are read from recorded quotes.",
      "Impact is naive on-chain execution through Jupiter's AMM routing.",
      ...(isExample ? ["PRODUCED WITH THE EXAMPLE ARTIFACT (TypeScript reference fit), not the Colab cost model. Re-run with models/cost-model.json for the headline result."] : []),
    ],
  };

  fs.mkdirSync(OUT, { recursive: true });
  const header = Object.keys(rows[0]);
  const csv = [header.join(","), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(","))].join("\n") + "\n";
  fs.writeFileSync(path.join(OUT, "orders.csv"), csv);
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  fs.writeFileSync(path.join(OUT, "summary.md"), markdown(summary));

  // ---- charts ----
  const colours = { deep: "#1f77b4", thin: "#ff7f0e" };
  const savingVsRho = path.join(OUT, "saving_vs_recovery.svg");
  fs.writeFileSync(savingVsRho, svgLineChart(
    "Advisor saving vs always-SEND_NOW, by pool recovery rho",
    "recovery fraction rho (0 = none, 1 = full)",
    "bps saved (positive = advisor cheaper)",
    depths.filter((d) => byDepthRho[d]["1.0"]).flatMap((d) => [
      { name: `${d} mean`, colour: colours[d], points: RHOS.map((rho) => [rho, byDepthRho[d][rho.toFixed(1)].advisorSavedBps.mean ?? NaN] as [number, number]) },
      { name: `${d} median`, colour: d === "deep" ? "#7fb2e0" : "#ffbf80", points: RHOS.map((rho) => [rho, byDepthRho[d][rho.toFixed(1)].advisorSavedBps.median ?? NaN] as [number, number]) },
    ]),
  ));
  const shareBySize = path.join(OUT, "saving_share_by_size.svg");
  const palette = ["#fdd0a2", "#fdae6b", "#fd8d3c", "#e6550d", "#a63603", "#7f2704", "#4a1500"];
  fs.writeFileSync(shareBySize, svgLineChart(
    "Thin pairs: median saving as % of SEND_NOW cost, by recovery rho",
    "recovery fraction rho (0 = none, 1 = full)",
    "median % of SEND_NOW cost saved",
    SIZE_BUCKETS.map(([bucket], i) => {
      const os = orders.filter((o) => o.depth === "thin" && o.bucket === bucket && o.control.bps > 0);
      return {
        name: `${bucket} (n=${os.length})`,
        colour: palette[i],
        points: RHOS.map((rho) => [rho, 100 * pct(os.map((o) => (o.control.bps - o.advisor[rho].realised.bps) / o.control.bps), 0.5)] as [number, number]),
      };
    }).filter((x) => !x.name.endsWith("(n=0)")),
  ));
  const dist = path.join(OUT, "saving_distribution.svg");
  fs.writeFileSync(dist, svgHistogram(
    "Distribution of bps saved per order (thin pairs; deep on its own chart)",
    "bps saved vs always-SEND_NOW",
    [
      { name: "thin, rho = 1", colour: "#ff7f0e", values: orders.filter((o) => o.depth === "thin").map((o) => o.control.bps - o.advisor[1].realised.bps) },
      { name: "thin, rho = 0", colour: "#8c564b", values: orders.filter((o) => o.depth === "thin").map((o) => o.control.bps - o.advisor[0].realised.bps) },
    ],
  ));
  const distDeep = path.join(OUT, "saving_distribution_deep.svg");
  fs.writeFileSync(distDeep, svgHistogram(
    "Distribution of bps saved per order (deep pairs)",
    "bps saved vs always-SEND_NOW",
    [
      { name: "deep, rho = 1", colour: "#1f77b4", values: orders.filter((o) => o.depth === "deep").map((o) => o.control.bps - o.advisor[1].realised.bps) },
      { name: "deep, rho = 0", colour: "#17becf", values: orders.filter((o) => o.depth === "deep").map((o) => o.control.bps - o.advisor[0].realised.bps) },
    ],
  ));
  for (const f of [savingVsRho, shareBySize, dist, distDeep]) toPng(f);

  console.log(fs.readFileSync(path.join(OUT, "summary.md"), "utf8"));
  console.log(`wrote ${path.relative(process.cwd(), OUT)}/: orders.csv (${rows.length} orders), summary.json, summary.md, charts`);
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

type Summary = {
  artifact: { modelVersion: string; producer: string; exampleOnly: boolean; trainCutoff: string };
  heldOut: { from: string; to: string; orders: number; ladders: number };
  setup: { capBps: number; feeUsd: number; latencySeconds: number; fixedSplit: { k: number; windowSeconds: number } };
  byDepthRho: Record<string, Record<string, {
    n: number; advisorSavedBps: Record<string, number | null>; fractionAdvisorWorseThanControl: number | null;
    advisorWorseThanControlCount: number; failureRate: Record<string, number | null>; feeSpendUsd: Record<string, number | null>;
    advisorModes: Record<string, number>; lowConfidenceShare: number | null;
    deferCheck: { n: number; helped: number; meanGainBps: number | null; medianGainBps: number | null };
  }>>;
  headline: Record<string, string | number | boolean | null>[];
  limitations: string[];
};

function markdown(s: Summary): string {
  const lines: string[] = [];
  lines.push(`# Backtest: execution-mode advisor on held-out mainnet quotes`, "");
  lines.push(`- Artifact: \`${s.artifact.modelVersion}\` (${s.artifact.producer})${s.artifact.exampleOnly ? " — **EXAMPLE ARTIFACT, not the Colab model**" : ""}`);
  lines.push(`- Trained before ${s.artifact.trainCutoff}; held-out orders ${s.heldOut.from} .. ${s.heldOut.to}: **${s.heldOut.orders} orders** from ${s.heldOut.ladders} ladders`);
  lines.push(`- Cap ${s.setup.capBps} bps, fee $${s.setup.feeUsd}/tx, latency ${s.setup.latencySeconds} s; control = always SEND_NOW; fixed baseline = split ${s.setup.fixedSplit.k} over ${s.setup.fixedSplit.windowSeconds} s`, "");
  lines.push(`## The recovery bracket (pool recovery rho is unmeasured)`, "");
  lines.push(`| depth | rho | n | mean saved | median saved | p5 | p95 | advisor worse than control | failure (ctl / adv / fixed) | fees $ (ctl / adv / fixed) | low confidence | modes |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const d of ["deep", "thin"]) {
    for (const rho of ["1.0", "0.5", "0.0"]) {
      const x = s.byDepthRho[d]?.[rho];
      if (!x) continue;
      const m = Object.entries(x.advisorModes).map(([k, v]) => `${k} ${v}`).join(", ");
      lines.push(`| ${d} | ${rho} | ${x.n} | ${x.advisorSavedBps.mean} | ${x.advisorSavedBps.median} | ${x.advisorSavedBps.p5} | ${x.advisorSavedBps.p95} | ${(100 * (x.fractionAdvisorWorseThanControl ?? 0)).toFixed(0)}% (${x.advisorWorseThanControlCount}) | ${x.failureRate.control} / ${x.failureRate.advisor} / ${x.failureRate.fixedSplit} | ${x.feeSpendUsd.control} / ${x.feeSpendUsd.advisor} / ${x.feeSpendUsd.fixedSplit} | ${(100 * (x.lowConfidenceShare ?? 0)).toFixed(0)}% | ${m} |`);
    }
  }
  lines.push("", `## Does DEFER help? Deferred plan vs the same plan executed at once`, "");
  lines.push(`| depth | rho | deferred orders | deferring was cheaper | mean gain bps | median gain bps |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const d of ["deep", "thin"]) {
    for (const rho of ["1.0", "0.5", "0.0"]) {
      const x = s.byDepthRho[d]?.[rho];
      if (!x) continue;
      lines.push(`| ${d} | ${rho} | ${x.deferCheck.n} | ${x.deferCheck.helped} | ${x.deferCheck.meanGainBps ?? "-"} | ${x.deferCheck.medianGainBps ?? "-"} |`);
    }
  }
  lines.push("", `## By size: savings at both bounds, breakeven recovery, and whether the choice flips`, "");
  lines.push(`| depth | size | n | control median bps | saved median (rho=1) | saved median (rho=0) | breakeven rho (median) | split never pays | modes at rho=1 | modes at rho=0 | choice flips | worse than control (rho=1) | low confidence |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const h of s.headline) {
    lines.push(`| ${h.depth} | ${h.sizeBucket} | ${h.n} | ${h.controlMedianBps} | ${h.savedMedianBpsRho1} | ${h.savedMedianBpsRho0} | ${h.breakevenRhoMedian ?? "-"} | ${h.splitNeverPays} | ${h.modeRho1} | ${h.modeRho0} | ${h.choiceFlips} | ${h.worseThanControlRho1} | ${h.lowConfidence} |`);
  }
  lines.push("", `## Limitations`, "", ...s.limitations.map((l) => `- ${l}`), "");
  return lines.join("\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
