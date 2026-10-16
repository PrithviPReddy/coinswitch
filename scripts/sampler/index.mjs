/**
 * Mainnet quote sampler.
 *
 * Records Jupiter quotes for six ordered pairs at a nine-rung ladder of sizes,
 * and for every other ladder re-asks a ~$100 rung after 5, 15, 30 and 60 s
 * (plus, about one set in ten, a large rung, to test whether drift depends on
 * size). The rows are the cost model's training data, so the rule is
 * absolute: a row is only ever written from a real response. A failed
 * request is logged, counted and skipped, never filled in.
 *
 * Three of the six pairs (JUP, BONK, WIF into USDC) are pairs the app never
 * settles. They are here on purpose: the deep pairs are flat at every size
 * the app trades, and a cost model needs markets where size costs something.
 *
 *   node scripts/sampler/index.mjs            continuous (default)
 *   node scripts/sampler/index.mjs --once     one ladder per pair, then exit
 *   node scripts/sampler/index.mjs --once --drift
 *                                             same, with drift re-quotes
 *
 * Mainnet is read only. Nothing in this process holds a key or signs.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { PrismaClient } from "../../app/generated/prisma/index.js";
import {
  DEEP_LADDER_SOL,
  DEFAULT_RETRY,
  THIN_LADDER_USD,
  PAIRS,
  TOKENS,
  buildDriftRow,
  buildLadderRows,
  createRateLimiter,
  decimalsMismatches,
  driftToleranceMs,
  getJson,
  effectivePriceDecimal,
  isDriftLadder,
  isDriftOnTime,
  isLargeDriftSet,
  ladderTooStale,
  parseNumberList,
  parsePrices,
  parseQuote,
  priceUrl,
  quoteUrl,
  rungBaseUnits,
} from "./core.mjs";

// Outside Docker the values live in .env. Inside, compose passes them in and
// there is no file, which is fine. Variables already set always win.
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const args = new Set(process.argv.slice(2));
const ONCE = args.has("--once");

// A key of its own for the sampler when there is one, so collection never
// competes with the app's quotes. Falls back to the app's key.
const dedicatedKey = Boolean(process.env.SAMPLER_JUP_API_KEY);
const apiKey = process.env.SAMPLER_JUP_API_KEY || process.env.JUP_API_KEY || undefined;

/** Compose passes unset knobs as "", which must mean the default, not 0. */
function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} is not a number: "${raw}"`);
  return value;
}

const config = {
  baseUrl: (process.env.SAMPLER_JUPITER_BASE_URL || "https://api.jup.ag").replace(/\/$/, ""),
  // Average load is set by the cycle: 6 pairs x 9 rungs every 120 s plus
  // drift is about 33 rpm, which leaves the app room on a shared key. With a
  // key of its own the sampler can afford 90 s.
  intervalSeconds: numberEnv("SAMPLER_INTERVAL_SECONDS", dedicatedKey ? 90 : 120),
  // The ceiling is about bursts, not the average. Jupiter counted 10
  // requests per fixed 10 s window per key on 2026-10-16 (5 without a key),
  // and a nine-rung ladder fired at once needs nine of them, so the cap has
  // to be the full 10.
  maxRpm: numberEnv("SAMPLER_MAX_RPM", apiKey ? 60 : 30),
  ladderSol: parseNumberList(process.env.SAMPLER_LADDER_SOL, DEEP_LADDER_SOL),
  ladderUsd: parseNumberList(process.env.SAMPLER_LADDER_USD, THIN_LADDER_USD),
  driftEvery: numberEnv("SAMPLER_DRIFT_EVERY", 2),
  driftDelays: parseNumberList(process.env.SAMPLER_DRIFT_DELAYS, [5, 15, 30, 60]),
  // Rung 2 is the ~$100 rung on both ladders.
  driftRungs: parseNumberList(process.env.SAMPLER_DRIFT_RUNGS, [2]),
  driftLargeRung: numberEnv("SAMPLER_DRIFT_LARGE_RUNG", 6),
  driftLargeEvery: numberEnv("SAMPLER_DRIFT_LARGE_EVERY", 10),
  slippageBps: numberEnv("SAMPLER_SLIPPAGE_BPS", 50),
  ladderMaxSpanSeconds: numberEnv("SAMPLER_LADDER_MAX_SPAN_SECONDS", 30),
  statusEverySeconds: numberEnv("SAMPLER_STATUS_SECONDS", 60),
  onceDrift: args.has("--drift"),
};

const WINDOW_MS = 10_000;
const PRICE_MAX_AGE_MS = 10 * 60_000;

const counters = {
  requests: 0,
  ok: 0,
  rate_limited: 0,
  no_route: 0,
  http: 0,
  network: 0,
  invalid: 0,
  failedRequests: 0,
  skippedNoPrice: 0,
  skippedDecimals: 0,
  dbErrors: 0,
  rungsCut: 0,
  driftLate: 0,
  driftOrphaned: 0,
  ladders: 0,
  samplesWritten: 0,
  driftWritten: 0,
};

function log(message, extra) {
  const line = `${new Date().toISOString()} [sampler] ${message}`;
  console.log(extra === undefined ? line : `${line} ${JSON.stringify(extra)}`);
}

const db = new PrismaClient();

const windowCap = Math.max(1, Math.floor((config.maxRpm * WINDOW_MS) / 60_000));

const limiter = createRateLimiter({
  maxRequests: windowCap,
  // One slot per window is kept back from low-priority requests for the
  // tight-tolerance drift re-quotes. See createRateLimiter.
  reserve: windowCap > 1 ? 1 : 0,
  windowMs: WINDOW_MS,
});

let stopping = false;
const timers = new Set();
const pendingDrift = new Set();

function later(ms, fn) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, Math.max(0, ms));
  timers.add(timer);
}

const sleep = (ms) =>
  new Promise((resolve) => {
    if (stopping) return resolve();
    later(ms, resolve);
  });

/**
 * Price lookups go keyless, on their own small limiter. Keyless traffic is
 * metered separately from the key (5 per 10 s, by IP), so a price refresh no
 * longer spends one of the key's 10 slots. With a nine-rung ladder in the
 * same window, that one slot was the +5 s re-quote's.
 */
const priceLimiter = createRateLimiter({ maxRequests: 2, windowMs: WINDOW_MS });

async function request(url, what, priority = "high", { keyless = false } = {}) {
  counters.requests++;

  const result = await getJson({
    url,
    apiKey: keyless ? undefined : apiKey,
    priority,
    limiter: keyless ? priceLimiter : limiter,
    retry: DEFAULT_RETRY,
    onEvent: (kind, detail) => {
      counters[kind]++;
      if (kind === "rate_limited") {
        log(
          detail?.gaveUp
            ? `429 from Jupiter on ${what}, retries exhausted`
            : `429 from Jupiter on ${what}, backing off`,
          { ...detail, total429: counters.rate_limited },
        );
      }
    },
  });

  if (result.ok) {
    counters.ok++;
  } else {
    counters.failedRequests++;
    log(`request failed: ${what}`, {
      kind: result.kind,
      status: result.status,
      error: result.body?.errorCode ?? result.message,
      failedRequests: counters.failedRequests,
    });
  }

  return result;
}

// --- prices -----------------------------------------------------------------

let prices = null;
let pricesAt = 0;
let priceFetch = null;
let badDecimals = new Set();

/** USD prices for sizing rungs and valuing notional. One fetch per interval, shared. */
async function currentPrices() {
  const fresh = Date.now() - pricesAt < config.intervalSeconds * 1000;
  if (prices && fresh) return prices;

  if (!priceFetch) {
    priceFetch = (async () => {
      const result = await request(
        priceUrl(config.baseUrl, Object.values(TOKENS).map((t) => t.mint)),
        "price v3",
        "low",
        { keyless: true },
      );

      if (result.ok) {
        const wrong = decimalsMismatches(result.data);
        badDecimals = new Set(wrong.map((t) => t.mint));
        for (const t of wrong) {
          log(`DECIMALS MISMATCH for ${t.symbol}: configured ${t.decimals}, Jupiter says ${result.data[t.mint].decimals}. Pairs with it are skipped.`);
        }

        const parsed = parsePrices(result.data);
        if (Object.values(TOKENS).every((t) => parsed[t.mint] > 0)) {
          prices = parsed;
          pricesAt = Date.now();
        }
      }
    })().finally(() => {
      priceFetch = null;
    });
  }

  await priceFetch;

  // A slightly stale price moves where a rung sits and shades notionalUsd by
  // the same small amount, never the quote itself, so it is usable for a
  // while. Past that, skip.
  return prices && Date.now() - pricesAt < PRICE_MAX_AGE_MS ? prices : null;
}

// --- ladders ----------------------------------------------------------------

/**
 * Samples one ladder and writes it. With drift on, each drift rung's
 * re-quotes are scheduled the moment that rung comes back, so a +5 s
 * re-quote really is five seconds after its origin rather than five seconds
 * after the slowest rung. Their rows wait for this ladder's insert, since
 * they reference it.
 */
async function sampleLadder(pair, { drift = false, largeDrift = false } = {}) {
  // Every ladder needs prices now: notionalUsd is recorded on every row.
  const usd = await currentPrices();
  if (!usd) {
    counters.skippedNoPrice++;
    log(`skipped ${pair.label} ladder: no usable USD price`);
    return [];
  }

  if (badDecimals.has(pair.input.mint) || badDecimals.has(pair.output.mint)) {
    counters.skippedDecimals++;
    return [];
  }

  const ladder = pair.ladderUnit === "USD" ? config.ladderUsd : config.ladderSol;
  const driftRungs = new Set(config.driftRungs);
  if (largeDrift) driftRungs.add(config.driftLargeRung);

  const ladderId = randomUUID();

  let settlePersisted;
  const persisted = new Promise((resolve) => {
    settlePersisted = resolve;
  });

  // Every rung is requested at once, so when the rate limit has room the
  // whole ladder comes back within one round trip and describes a single
  // market instant. A rung that only comes back long after the ladder was
  // fired (retries, a queue, a sleeping machine) is from a different instant
  // and is dropped rather than measured against rung 0.
  const firedAt = Date.now();
  const maxSpanMs = config.ladderMaxSpanSeconds * 1000;

  const fetched = await Promise.all(
    ladder.map(async (size, rung) => {
      if (stopping) return null;

      const amount = rungBaseUnits(pair.input, size, usd, pair.ladderUnit);
      const result = await request(
        quoteUrl(config.baseUrl, {
          inputMint: pair.input.mint,
          outputMint: pair.output.mint,
          amount,
          slippageBps: config.slippageBps,
        }),
        `${pair.label} rung ${rung}`,
      );

      if (!result.ok) return null;

      if (ladderTooStale(firedAt, result.receivedAt, maxSpanMs)) {
        counters.rungsCut++;
        log(`dropped ${pair.label} rung ${rung}: answered past the ${config.ladderMaxSpanSeconds}s ladder span`, {
          rungsCut: counters.rungsCut,
        });
        return null;
      }

      const quote = parseQuote(result.data);
      if (!quote) {
        counters.invalid++;
        counters.failedRequests++;
        log(`unusable quote body: ${pair.label} rung ${rung}`);
        return null;
      }

      const record = {
        id: randomUUID(),
        rung,
        quote,
        sampledAt: result.receivedAt,
        latencyMs: result.latencyMs,
        requestedSlippageBps: config.slippageBps,
      };

      if (drift && driftRungs.has(rung)) {
        scheduleDrift(pair, {
          id: record.id,
          ladderRung: rung,
          inAmountBaseUnits: quote.inAmount,
          sampledAt: new Date(record.sampledAt),
          effectivePrice: effectivePriceDecimal(
            quote.inAmount,
            quote.outAmount,
            pair.input.decimals,
            pair.output.decimals,
          ),
        }, persisted);
      }

      return record;
    }),
  );

  const rungs = fetched.filter(Boolean);

  if (!rungs.length) {
    settlePersisted(false);
    return [];
  }

  const rows = buildLadderRows({ pair, ladderId, rungs, makeId: randomUUID, usdPrices: usd });

  try {
    await db.quoteSample.createMany({ data: rows });
    counters.samplesWritten += rows.length;
    counters.ladders++;
    settlePersisted(true);
  } catch (error) {
    counters.dbErrors++;
    settlePersisted(false);
    log(`could not write ${pair.label} ladder`, { error: String(error?.message ?? error) });
    return [];
  }

  const times = rows.map((r) => r.sampledAt.getTime());
  log(`ladder ${pair.label}`, {
    rungs: `${rows.length}/${ladder.length}`,
    spanMs: Math.max(...times) - Math.min(...times),
  });

  return rows;
}

// --- drift ------------------------------------------------------------------

async function requoteOnce(pair, origin, delaySeconds, persisted) {
  if (stopping) return;

  const originMs = origin.sampledAt.getTime();
  const label = `${pair.label} rung ${origin.ladderRung} drift +${delaySeconds}s`;

  // Already too late to be a +delaySeconds observation (the machine slept,
  // or the queue backed up): spend no request on it.
  if (!isDriftOnTime(originMs, delaySeconds, Date.now())) {
    counters.driftLate++;
    log(`skipped ${label}: too late to start`, {
      lateByMs: Date.now() - originMs - delaySeconds * 1000,
      driftLate: counters.driftLate,
    });
    return;
  }

  const result = await request(
    quoteUrl(config.baseUrl, {
      inputMint: pair.input.mint,
      outputMint: pair.output.mint,
      amount: origin.inAmountBaseUnits,
      slippageBps: config.slippageBps,
    }),
    label,
    // Tight tolerances (+5 s: 2 s, +15 s: 3.75 s) cannot afford to queue
    // behind a ladder window; +30 s and +60 s have 7.5-15 s and can.
    driftToleranceMs(delaySeconds) < 5_000 ? "urgent" : "low",
  );

  if (!result.ok) return;

  if (!isDriftOnTime(originMs, delaySeconds, result.receivedAt)) {
    counters.driftLate++;
    log(`dropped ${label}: answered too late`, {
      lateByMs: result.receivedAt - originMs - delaySeconds * 1000,
      driftLate: counters.driftLate,
    });
    return;
  }

  const quote = parseQuote(result.data);
  if (!quote || quote.inAmount !== origin.inAmountBaseUnits) {
    counters.invalid++;
    counters.failedRequests++;
    log(`unusable drift body: ${pair.label} rung ${origin.ladderRung} +${delaySeconds}s`);
    return;
  }

  const row = buildDriftRow({
    origin,
    pair,
    delaySeconds,
    quote,
    requotedAt: result.receivedAt,
    latencyMs: result.latencyMs,
    makeId: randomUUID,
  });

  if (!(await persisted)) {
    counters.driftOrphaned++;
    return;
  }

  try {
    await db.quoteDrift.create({ data: row });
    counters.driftWritten++;
  } catch (error) {
    counters.dbErrors++;
    log("could not write drift row", { error: String(error?.message ?? error) });
  }
}

/** Schedules every re-quote for one origin rung; resolves when all have run. */
function scheduleDrift(pair, origin, persisted) {
  const jobs = config.driftDelays.map(
    (delaySeconds) =>
      new Promise((resolve) => {
        const due = origin.sampledAt.getTime() + delaySeconds * 1000;
        later(due - Date.now(), () => {
          requoteOnce(pair, origin, delaySeconds, persisted)
            .catch((error) => log("drift job threw", { error: String(error) }))
            .finally(resolve);
        });
      }),
  );

  const all = Promise.all(jobs);
  pendingDrift.add(all);
  all.finally(() => pendingDrift.delete(all));
  return all;
}

// --- loops ------------------------------------------------------------------

async function pairLoop(pair, pairIndex) {
  // Pairs start staggered across the interval so their ladders do not all
  // land in the same rate-limit window.
  const offsetMs = (pairIndex * config.intervalSeconds * 1000) / PAIRS.length;
  let due = Date.now() + offsetMs;
  let ladderNumber = 0;
  let driftSetNumber = 0;

  while (!stopping) {
    await sleep(due - Date.now());
    if (stopping) break;

    try {
      const drift = isDriftLadder(ladderNumber, pairIndex, config.driftEvery);
      const largeDrift =
        drift && isLargeDriftSet(driftSetNumber, pairIndex, config.driftLargeEvery);
      if (drift) driftSetNumber++;

      await sampleLadder(pair, { drift, largeDrift });
    } catch (error) {
      log(`ladder ${pair.label} threw`, { error: String(error?.message ?? error) });
    }

    ladderNumber++;
    due += config.intervalSeconds * 1000;

    // A ladder that overran its slot starts the next one now rather than
    // firing a burst of catch-up ladders.
    if (due < Date.now()) due = Date.now();
  }
}

async function runOnce() {
  for (const pair of PAIRS) {
    await sampleLadder(pair, { drift: config.onceDrift, largeDrift: config.onceDrift });
  }

  // Drift jobs keep being added until the last ladder finishes, so wait for
  // the set to drain rather than for a snapshot of it.
  while (pendingDrift.size) await Promise.all([...pendingDrift]);
}

function status() {
  log("status", { ...counters, pendingDriftLadders: pendingDrift.size });
}

async function waitForDatabase() {
  for (let attempt = 1; !stopping; attempt++) {
    try {
      await db.$queryRaw`SELECT 1`;
      return;
    } catch (error) {
      const delay = Math.min(30_000, 1000 * 2 ** attempt);
      log(`database not reachable, retrying in ${delay} ms`, {
        error: String(error?.message ?? error).split("\n")[0],
      });
      await sleep(delay);
    }
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} received, stopping`);
  for (const timer of timers) clearTimeout(timer);
  status();
  await db.$disconnect().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Last line of defence: a stray rejection is logged and counted, not fatal.
process.on("unhandledRejection", (reason) => {
  log("unhandled rejection", { error: String(reason) });
});

async function main() {
  log(`starting (${ONCE ? "once" : "continuous"})`, {
    ...config,
    apiKey: apiKey ? (dedicatedKey ? "dedicated (SAMPLER_JUP_API_KEY)" : "shared (JUP_API_KEY)") : "not set",
    pairs: PAIRS.map((p) => p.label),
  });

  await waitForDatabase();

  if (ONCE) {
    await runOnce();
    status();
    await db.$disconnect();
    return;
  }

  const statusTimer = setInterval(status, config.statusEverySeconds * 1000);
  statusTimer.unref();

  await Promise.all(PAIRS.map((pair, i) => pairLoop(pair, i)));
}

main().catch(async (error) => {
  log("fatal", { error: String(error?.stack ?? error) });
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
