import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEEP_LADDER_SOL,
  PAIRS,
  THIN_LADDER_USD,
  TOKENS,
  buildDriftRow,
  buildLadderRows,
  createRateLimiter,
  decimalsMismatches,
  degradationBps,
  effectivePrice,
  effectivePriceDecimal,
  getJson,
  isDriftLadder,
  isDriftOnTime,
  isLargeDriftSet,
  ladderTooStale,
  notionalUsd,
  parsePrices,
  parseQuote,
  quoteUrl,
  rungBaseUnits,
  toBaseUnits,
} from "./core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(here, "__fixtures__", name), "utf8"));

// Recorded from mainnet Jupiter on 2026-10-16. Tests never call the network.
const QUOTE = fixture("quote-sol-usdc-1sol.json");
const PRICES = fixture("price-v3.json");
const NO_ROUTES = fixture("error-no-routes.json");

const SOL_USDC = PAIRS.find((p) => p.label === "SOL/USDC");
const USDC_SOL = PAIRS.find((p) => p.label === "USDC/SOL");

/** A clock that only moves when something sleeps on it. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += Math.max(0, ms);
    },
  };
}

function response(status, body, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

function scriptedFetch(responses) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

const FAST_RETRY = {
  maxRateLimitRetries: 3,
  maxTransientRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  timeoutMs: 1_000,
};

describe("pairs", () => {
  it("samples three deep pairs and three thin pairs, six in all", () => {
    expect(PAIRS.map((p) => `${p.label}:${p.depth}`)).toEqual([
      "SOL/USDC:deep",
      "USDC/SOL:deep",
      "SOL/USDT:deep",
      "JUP/USDC:thin",
      "BONK/USDC:thin",
      "WIF/USDC:thin",
    ]);
  });

  it("sizes deep pairs in SOL and thin pairs in USD", () => {
    expect(PAIRS.filter((p) => p.depth === "deep").every((p) => p.ladderUnit === "SOL")).toBe(true);
    expect(PAIRS.filter((p) => p.depth === "thin").every((p) => p.ladderUnit === "USD")).toBe(true);
  });
});

describe("ladders", () => {
  it("keeps v1 rungs 0-6 exactly and appends 2,000 and 10,000 SOL", () => {
    expect(DEEP_LADDER_SOL.slice(0, 7)).toEqual([0.05, 0.25, 1, 5, 20, 100, 400]);
    expect(DEEP_LADDER_SOL.slice(7)).toEqual([2_000, 10_000]);
  });

  it("has a thin USD rung for every deep rung", () => {
    expect(THIN_LADDER_USD).toHaveLength(DEEP_LADDER_SOL.length);
  });

  it("puts rung 2, the drift rung, near $100 on both ladders at SOL ~ $106", () => {
    expect(DEEP_LADDER_SOL[2] * 106).toBeCloseTo(106, 0);
    expect(THIN_LADDER_USD[2]).toBe(100);
  });
});

describe("ladder sizing", () => {
  const usd = parsePrices(PRICES);

  it("sizes SOL rungs directly in lamports", () => {
    expect(rungBaseUnits(TOKENS.SOL, 0.05, null)).toBe(50_000_000n);
    expect(rungBaseUnits(TOKENS.SOL, 400, null)).toBe(400_000_000_000n);
  });

  it("converts a SOL-equivalent rung into USDC at the given prices", () => {
    const expected = toBaseUnits(
      (1 * usd[TOKENS.SOL.mint]) / usd[TOKENS.USDC.mint],
      6,
    );
    expect(rungBaseUnits(TOKENS.USDC, 1, usd)).toBe(expected);
    // About $105 of SOL at the recorded price.
    expect(Number(expected) / 1e6).toBeGreaterThan(100);
    expect(Number(expected) / 1e6).toBeLessThan(110);
  });

  it("sizes a USD rung directly at the token's price, including 5-decimal BONK", () => {
    const prices = { [TOKENS.BONK.mint]: 0.000003, [TOKENS.JUP.mint]: 0.31 };
    // $25 of BONK at $0.000003 is 8,333,333.33333 BONK, at 5 decimals.
    expect(rungBaseUnits(TOKENS.BONK, 25, prices, "USD")).toBe(833_333_333_333n);
    expect(rungBaseUnits(TOKENS.JUP, 1_000_000, prices, "USD")).toBe(
      toBaseUnits(1_000_000 / 0.31, 6),
    );
  });

  it("refuses to size a non-SOL rung without prices rather than guessing", () => {
    expect(() => rungBaseUnits(TOKENS.USDT, 1, {})).toThrow(/No USD price/);
  });

  it("avoids float drift at nine decimals", () => {
    expect(toBaseUnits(0.1 + 0.2, 9)).toBe(300_000_000n);
  });
});

describe("price arithmetic", () => {
  it("computes output per input in whole tokens", () => {
    // 1 SOL in, 105.023201 USDC out.
    expect(effectivePrice(QUOTE.inAmount, QUOTE.outAmount, 9, 6)).toBeCloseTo(
      105.023201,
      9,
    );
  });

  it("stores the price exactly, with no float noise", () => {
    // 5.255503 USDC for 0.05 SOL is exactly 105.11006.
    expect(effectivePriceDecimal("50000000", "5255503", 9, 6)).toBe(
      "105.110060000000000000",
    );
    // Prices below one keep their leading zeros.
    expect(effectivePriceDecimal("1000000000", "1", 9, 6)).toBe(
      "0.000001000000000000",
    );
  });

  it("is positive when the price got worse", () => {
    expect(degradationBps(100, 99)).toBeCloseTo(100, 9);
    expect(degradationBps(100, 101)).toBeCloseTo(-100, 9);
    expect(degradationBps(100, 100)).toBe(0);
  });
});

describe("parseQuote", () => {
  it("reads the fields the sampler records from a real response", () => {
    const q = parseQuote(QUOTE);
    expect(q).toMatchObject({
      inAmount: "1000000000",
      outAmount: "105023201",
      reportedImpactPct: 0,
      routeLabels: ["Kipseli"],
      hopCount: 1,
      slippageBps: 50,
      contextSlot: 457496607,
    });
  });

  it("rejects bodies that would produce a row from nothing", () => {
    expect(parseQuote(null)).toBeNull();
    expect(parseQuote({ ...QUOTE, outAmount: undefined })).toBeNull();
    expect(parseQuote({ ...QUOTE, outAmount: "0" })).toBeNull();
    expect(parseQuote({ ...QUOTE, routePlan: undefined })).toBeNull();
    expect(parseQuote(NO_ROUTES)).toBeNull();
  });

  it("drops a slot that does not fit the int4 column instead of truncating it", () => {
    expect(parseQuote({ ...QUOTE, contextSlot: 3_000_000_000 }).contextSlot).toBeNull();
  });
});

describe("buildLadderRows", () => {
  const quoteAt = (inAmount, outAmount, routeLabel = "Kipseli") =>
    parseQuote({
      ...QUOTE,
      inAmount,
      outAmount,
      routePlan: [{ swapInfo: { label: routeLabel } }],
    });
  const usdPrices = { [TOKENS.SOL.mint]: 105, [TOKENS.USDC.mint]: 1 };

  it("measures impact against rung 1 of the same ladder, not rung 0", () => {
    let n = 0;
    const rows = buildLadderRows({
      pair: SOL_USDC,
      ladderId: "L1",
      makeId: () => `id${n++}`,
      usdPrices,
      rungs: [
        // Rung 0 routes elsewhere and gets a slightly better price: under the
        // v1 baseline that made every larger rung look negative.
        { rung: 0, quote: quoteAt("50000000", "5260000", "Obsidian"), sampledAt: 1, latencyMs: 9, requestedSlippageBps: 50 },
        { rung: 1, quote: quoteAt("250000000", "26250000"), sampledAt: 1, latencyMs: 10, requestedSlippageBps: 50 },
        { rung: 3, quote: quoteAt("5000000000", "519750000", "BisonFi"), sampledAt: 2, latencyMs: 12, requestedSlippageBps: 50 },
      ],
    });

    expect(rows.map((r) => r.measuredImpactBps)).toEqual([
      "-19.047619",
      "0.000000",
      "100.000000",
    ]);
    // Every row carries the baseline's route next to its own.
    expect(rows.map((r) => [r.routeLabels[0], r.baselineRouteLabels[0]])).toEqual([
      ["Obsidian", "Kipseli"],
      ["Kipseli", "Kipseli"],
      ["BisonFi", "Kipseli"],
    ]);
    expect(rows.every((r) => r.ladderId === "L1")).toBe(true);
    expect(rows[2]).toMatchObject({
      pair: "SOL/USDC",
      inputMint: TOKENS.SOL.mint,
      outputMint: TOKENS.USDC.mint,
      inAmountBaseUnits: "5000000000",
      outAmountBaseUnits: "519750000",
      ladderRung: 3,
      apiLatencyMs: 12,
      // 5 SOL at $105.
      notionalUsd: "525.000000",
      notionalSource: "price_v3",
    });
  });

  it("leaves impact null when the baseline rung is missing instead of borrowing one", () => {
    const rows = buildLadderRows({
      pair: SOL_USDC,
      ladderId: "L2",
      makeId: () => "x",
      usdPrices,
      rungs: [
        { rung: 2, quote: quoteAt("1000000000", "105000000"), sampledAt: 1, latencyMs: 10, requestedSlippageBps: 50 },
      ],
    });
    expect(rows[0].measuredImpactBps).toBeNull();
    expect(rows[0].baselineRouteLabels).toEqual([]);
  });

  it("refuses to write a row it cannot value", () => {
    expect(() =>
      buildLadderRows({
        pair: SOL_USDC,
        ladderId: "L4",
        makeId: () => "x",
        usdPrices: {},
        rungs: [{ rung: 1, quote: quoteAt("250000000", "26250000"), sampledAt: 1, latencyMs: 1, requestedSlippageBps: 50 }],
      }),
    ).toThrow(/No USD price/);
  });
});

describe("notionalUsd", () => {
  it("values the input at its USD price", () => {
    expect(notionalUsd(TOKENS.SOL, "2000000000000", { [TOKENS.SOL.mint]: 106 })).toBe(212_000);
    expect(notionalUsd(TOKENS.BONK, "833333333333", { [TOKENS.BONK.mint]: 0.000003 })).toBeCloseTo(25, 6);
  });
});

describe("decimalsMismatches", () => {
  it("flags a token whose configured decimals disagree with Jupiter", () => {
    const body = {
      [TOKENS.BONK.mint]: { usdPrice: 0.000003, decimals: 5 },
      [TOKENS.WIF.mint]: { usdPrice: 0.2, decimals: 9 },
    };
    expect(decimalsMismatches(body).map((t) => t.symbol)).toEqual(["WIF"]);
  });

  it("finds nothing wrong in the recorded price response", () => {
    expect(decimalsMismatches(PRICES)).toEqual([]);
  });
});

describe("buildDriftRow", () => {
  it("is positive when the re-quote pays out less", () => {
    const origin = {
      id: "o1",
      effectivePrice: "0.009500000000000000",
      inAmountBaseUnits: "105000000",
      sampledAt: new Date(1_000_000),
    };
    // 105 USDC now buys 0.99 of what it bought before: 100 bps adverse.
    const quote = parseQuote({
      ...QUOTE,
      inAmount: "105000000",
      outAmount: String(Math.round(105 * 0.0095 * 0.99 * 1e9)),
    });

    const row = buildDriftRow({
      origin,
      pair: USDC_SOL,
      delaySeconds: 15,
      quote,
      requotedAt: 1_015_250,
      latencyMs: 7,
      makeId: () => "d1",
    });

    expect(Number(row.driftBps)).toBeCloseTo(100, 3);
    expect(row).toMatchObject({
      originSampleId: "o1",
      delaySeconds: 15,
      // Stored, so no analysis has to re-derive the real horizon.
      actualElapsedMs: 15_250,
    });
  });
});

describe("drift selection", () => {
  it("re-quotes the large rung on about one drift set in ten, per pair", () => {
    const large = (pairIndex) =>
      Array.from({ length: 30 }, (_, n) => n).filter((n) => isLargeDriftSet(n, pairIndex, 10));
    expect(large(0)).toEqual([0, 10, 20]);
    expect(large(3)).toEqual([7, 17, 27]);
  });

  it("drifts one ladder in every N per pair, offset by pair", () => {
    const picked = (pairIndex) =>
      [0, 1, 2, 3, 4, 5, 6, 7].filter((n) => isDriftLadder(n, pairIndex, 4));
    expect(picked(0)).toEqual([0, 4]);
    expect(picked(1)).toEqual([3, 7]);
    expect(isDriftLadder(0, 0, 0)).toBe(false);
  });
});

describe("drift timing", () => {
  const origin = 1_000_000;

  it("accepts a re-quote within the larger of 2 s and 25% of the delay", () => {
    expect(isDriftOnTime(origin, 5, origin + 7_000)).toBe(true); // 2 s late
    expect(isDriftOnTime(origin, 5, origin + 7_001)).toBe(false);
    // The +5 s re-quote that landed at +9.7 s under a saturated limiter.
    expect(isDriftOnTime(origin, 5, origin + 9_700)).toBe(false);
    expect(isDriftOnTime(origin, 60, origin + 75_000)).toBe(true); // 15 s late
    expect(isDriftOnTime(origin, 60, origin + 75_001)).toBe(false);
  });

  it("rejects the +5 s re-quote that fired after the machine slept", () => {
    expect(isDriftOnTime(origin, 5, origin + 70 * 60_000)).toBe(false);
  });
});

describe("ladder span", () => {
  it("drops a rung answered past the span cap", () => {
    expect(ladderTooStale(0, 30_000, 30_000)).toBe(false);
    expect(ladderTooStale(0, 30_001, 30_000)).toBe(true);
  });

  it("uses a rung's pre-assigned id so drift can reference it early", () => {
    const rows = buildLadderRows({
      pair: SOL_USDC,
      ladderId: "L3",
      makeId: () => "generated",
      usdPrices: { [TOKENS.SOL.mint]: 105 },
      rungs: [
        { id: "pre", rung: 0, quote: parseQuote(QUOTE), sampledAt: 1, latencyMs: 1, requestedSlippageBps: 50 },
        { rung: 1, quote: parseQuote(QUOTE), sampledAt: 2, latencyMs: 1, requestedSlippageBps: 50 },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(["pre", "generated"]);
  });
});

describe("rate limiter", () => {
  it("never grants more than the cap in any window", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ maxRequests: 3, windowMs: 10_000, ...clock });

    const grants = [];
    for (let i = 0; i < 10; i++) {
      await limiter.acquire();
      grants.push(clock.now());
    }

    for (const t of grants) {
      const inWindow = grants.filter((g) => g >= t && g < t + 10_000).length;
      expect(inWindow).toBeLessThanOrEqual(3);
    }
  });

  it("serves waiting ladder rungs before waiting drift re-quotes", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 10_000, ...clock });

    await limiter.acquire(); // fills the window
    const order = [];
    const pending = [
      limiter.acquire("low").then(() => order.push("drift-1")),
      limiter.acquire("low").then(() => order.push("drift-2")),
      limiter.acquire("high").then(() => order.push("rung")),
    ];
    await Promise.all(pending);

    expect(order).toEqual(["rung", "drift-1", "drift-2"]);
  });

  it("holds every caller back while paused", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ maxRequests: 10, windowMs: 10_000, ...clock });
    limiter.pauseUntil(clock.now() + 5_000);
    await limiter.acquire();
    expect(clock.now()).toBeGreaterThanOrEqual(1_005_000);
  });
});

describe("getJson", () => {
  const limiterFor = (clock) =>
    createRateLimiter({ maxRequests: 100, windowMs: 10_000, ...clock });

  it("backs off on 429 and then succeeds", async () => {
    const clock = fakeClock();
    const events = [];
    const { fetchImpl, calls } = scriptedFetch([
      response(429, { error: "rate limited" }),
      response(429, { error: "rate limited" }),
      response(200, QUOTE),
    ]);

    const result = await getJson({
      url: quoteUrl("https://jup.test", {
        inputMint: TOKENS.SOL.mint,
        outputMint: TOKENS.USDC.mint,
        amount: 1_000_000_000n,
        slippageBps: 50,
      }),
      fetchImpl,
      limiter: limiterFor(clock),
      retry: FAST_RETRY,
      random: () => 0,
      onEvent: (kind) => events.push(kind),
      ...clock,
    });

    expect(result.ok).toBe(true);
    expect(result.data.outAmount).toBe("105023201");
    expect(calls).toHaveLength(3);
    expect(events).toEqual(["rate_limited", "rate_limited"]);
    // 1 s then 2 s of exponential backoff before the third attempt.
    expect(clock.now()).toBeGreaterThanOrEqual(1_003_000);
  });

  it("waits for the advertised reset when it is later than the backoff", async () => {
    const clock = fakeClock(1_000_000);
    const resetSeconds = String((1_000_000 + 6_000) / 1000);
    const { fetchImpl } = scriptedFetch([
      response(429, {}, { "x-ratelimit-reset": resetSeconds }),
      response(200, QUOTE),
    ]);

    await getJson({
      url: "https://jup.test/q",
      fetchImpl,
      limiter: limiterFor(clock),
      retry: FAST_RETRY,
      random: () => 0,
      ...clock,
    });

    expect(clock.now()).toBeGreaterThanOrEqual(1_006_000);
  });

  it("gives up after the retry budget and reports it, without throwing", async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = scriptedFetch(
      Array.from({ length: 10 }, () => response(429, {})),
    );

    const result = await getJson({
      url: "https://jup.test/q",
      fetchImpl,
      limiter: limiterFor(clock),
      retry: FAST_RETRY,
      random: () => 0,
      ...clock,
    });

    expect(result).toMatchObject({ ok: false, kind: "rate_limited", status: 429 });
    expect(calls).toHaveLength(FAST_RETRY.maxRateLimitRetries + 1);
  });

  it("does not retry a no-route answer", async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = scriptedFetch([response(400, NO_ROUTES)]);

    const result = await getJson({
      url: "https://jup.test/q",
      fetchImpl,
      limiter: limiterFor(clock),
      retry: FAST_RETRY,
      ...clock,
    });

    expect(result).toMatchObject({ ok: false, kind: "no_route", status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("retries network errors and 5xx, then reports the failure", async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = scriptedFetch([
      new Error("ECONNRESET"),
      response(502, undefined),
      new Error("ECONNRESET"),
    ]);

    const result = await getJson({
      url: "https://jup.test/q",
      fetchImpl,
      limiter: limiterFor(clock),
      retry: FAST_RETRY,
      random: () => 0,
      ...clock,
    });

    expect(result).toMatchObject({ ok: false, kind: "network" });
    expect(calls).toHaveLength(3);
  });

  it("sends the API key header only when there is one", async () => {
    const clock = fakeClock();
    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push(init.headers);
      return response(200, QUOTE);
    };

    await getJson({ url: "u", apiKey: "k", fetchImpl, limiter: limiterFor(clock), ...clock });
    await getJson({ url: "u", fetchImpl, limiter: limiterFor(clock), ...clock });

    expect(seen).toEqual([{ "x-api-key": "k" }, undefined]);
  });
});
