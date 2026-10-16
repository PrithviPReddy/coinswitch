/**
 * The parts of the quote sampler that do not touch the database: ladder
 * sizing, the price arithmetic, the rate limiter and the retrying HTTP call.
 * Kept free of Prisma and of real timers so the tests can drive all of it
 * with recorded responses and a fake clock.
 *
 * Everything here reads mainnet. Nothing here signs, sends or settles.
 */

export const TOKENS = {
  SOL: {
    symbol: "SOL",
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
  },
  USDC: {
    symbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
  USDT: {
    symbol: "USDT",
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    decimals: 6,
  },
  // Mid-caps with a few million dollars of liquidity each (Jupiter price v3,
  // 2026-10-16: JUP $5.5M, BONK $6.2M, WIF $6.2M, against SOL's $944M).
  // This is where size actually costs something.
  JUP: {
    symbol: "JUP",
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    decimals: 6,
  },
  BONK: {
    symbol: "BONK",
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    decimals: 5,
  },
  WIF: {
    symbol: "WIF",
    mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    decimals: 6,
  },
};

/**
 * Deep pairs: rungs as SOL-equivalent input size. Rungs 0-6 are exactly the
 * v1 ladder, so rows collected before 2026-10-16 07:30 UTC keep their rung
 * index; 7 and 8 were appended.
 */
export const DEEP_LADDER_SOL = [0.05, 0.25, 1, 5, 20, 100, 400, 2_000, 10_000];

/**
 * Thin pairs: rungs as USD notional, set to roughly what the deep ladder's
 * rungs were worth at SOL ≈ $106 so notionalUsd lines up across every pair.
 */
export const THIN_LADDER_USD = [5, 25, 100, 500, 2_000, 10_000, 40_000, 200_000, 1_000_000];

/** Kept for code that still asks for the v1 name. */
export const DEFAULT_LADDER_SOL = DEEP_LADDER_SOL;

/**
 * Ordered pairs, input first. The pair label is always "INPUT/OUTPUT".
 *
 * This deliberately covers pairs the app does not settle: the three thin
 * pairs exist so the cost model sees markets where size matters. The app
 * only ever settles SOL, USDC and USDT.
 */
export const PAIRS = [
  { input: "SOL", output: "USDC", depth: "deep" },
  { input: "USDC", output: "SOL", depth: "deep" },
  { input: "SOL", output: "USDT", depth: "deep" },
  { input: "JUP", output: "USDC", depth: "thin" },
  { input: "BONK", output: "USDC", depth: "thin" },
  { input: "WIF", output: "USDC", depth: "thin" },
].map(({ input, output, depth }) => ({
  label: `${input}/${output}`,
  input: TOKENS[input],
  output: TOKENS[output],
  depth,
  ladderUnit: depth === "deep" ? "SOL" : "USD",
}));

/** Impact is measured against this rung of the same ladder; see buildLadderRows. */
export const IMPACT_BASELINE_RUNG = 1;

/**
 * Same parameters /api/quote sends, so the recorded market is the one the
 * app's users are actually quoted against.
 */
export const QUOTE_PARAMS = {
  swapMode: "ExactIn",
  restrictIntermediateTokens: "true",
  maxAccounts: "64",
};

const INT4_MAX = 2_147_483_647;

export const defaultSleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Whole-token amount to base units, via a fixed-point string to avoid float drift. */
export function toBaseUnits(amount, decimals) {
  const [whole, fraction = ""] = amount.toFixed(decimals).split(".");
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/**
 * Converts a rung size into base units of the input token. `unit` is "SOL"
 * (a SOL-equivalent size, the deep ladder) or "USD" (a notional, the thin
 * ladder). SOL rungs on a SOL input need no price. Everything else is
 * converted at the USD prices passed in, which only decides how big the rung
 * is; the quote recorded at it is Jupiter's.
 */
export function rungBaseUnits(inputToken, size, usdPrices, unit = "SOL") {
  if (unit === "SOL" && inputToken.symbol === "SOL") {
    return toBaseUnits(size, inputToken.decimals);
  }

  const tokenUsd = usdPrices?.[inputToken.mint];
  if (!(tokenUsd > 0)) throw new Error(`No USD price for ${inputToken.symbol}`);

  if (unit === "USD") return toBaseUnits(size / tokenUsd, inputToken.decimals);

  const solUsd = usdPrices?.[TOKENS.SOL.mint];
  if (!(solUsd > 0)) throw new Error("No USD price for SOL");

  return toBaseUnits((size * solUsd) / tokenUsd, inputToken.decimals);
}

/**
 * What the input of a quote was worth in USD at sample time, at Jupiter's
 * price v3. This is the size feature the model trains on; the rung index is
 * only a label.
 */
export function notionalUsd(inputToken, inBaseUnits, usdPrices) {
  const tokenUsd = usdPrices?.[inputToken.mint];
  if (!(tokenUsd > 0)) throw new Error(`No USD price for ${inputToken.symbol}`);
  return (Number(BigInt(inBaseUnits)) / 10 ** inputToken.decimals) * tokenUsd;
}

/**
 * Output per unit of input, both in whole tokens, as an exact decimal string
 * truncated to `places`. Integer arithmetic throughout, so the stored price
 * is exactly what the base units say rather than a float's nearest guess.
 */
export function effectivePriceDecimal(
  inBaseUnits,
  outBaseUnits,
  inDecimals,
  outDecimals,
  places = 18,
) {
  const scaled =
    (BigInt(outBaseUnits) * 10n ** BigInt(inDecimals + places)) /
    (BigInt(inBaseUnits) * 10n ** BigInt(outDecimals));
  const digits = scaled.toString().padStart(places + 1, "0");
  return `${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

/** The same price as a number, for basis-point arithmetic. */
export function effectivePrice(inBaseUnits, outBaseUnits, inDecimals, outDecimals) {
  return Number(effectivePriceDecimal(inBaseUnits, outBaseUnits, inDecimals, outDecimals));
}

/**
 * How much worse a price is than a reference price, in basis points.
 * Positive means worse. Used for both impact (rung i against rung 0) and
 * drift (a re-quote against its origin).
 */
export function degradationBps(referencePrice, price) {
  return ((referencePrice - price) / referencePrice) * 10_000;
}

/** Decimal string for Prisma, never in exponent notation. */
export function decimalString(value, places) {
  if (!Number.isFinite(value)) throw new Error(`Not a finite number: ${value}`);
  return value.toFixed(places);
}

/** Jupiter returns slots as numbers; the column is int4. */
export function slotOrNull(slot) {
  return Number.isInteger(slot) && slot >= 0 && slot <= INT4_MAX ? slot : null;
}

const DIGITS = /^\d+$/;

/** Checks the fields the sampler depends on before anything is recorded. */
export function parseQuote(data) {
  if (
    !data ||
    !DIGITS.test(String(data.inAmount)) ||
    !DIGITS.test(String(data.outAmount)) ||
    !Array.isArray(data.routePlan)
  ) {
    return null;
  }

  if (BigInt(data.inAmount) === BigInt(0) || BigInt(data.outAmount) === BigInt(0)) {
    return null;
  }

  const impact = Number(data.priceImpactPct);

  return {
    inAmount: String(data.inAmount),
    outAmount: String(data.outAmount),
    reportedImpactPct:
      data.priceImpactPct === undefined ||
      data.priceImpactPct === null ||
      !Number.isFinite(impact)
        ? null
        : impact,
    routeLabels: data.routePlan
      .map((leg) => leg?.swapInfo?.label)
      .filter((label) => typeof label === "string" && label.length > 0),
    hopCount: data.routePlan.length,
    slippageBps: Number.isInteger(data.slippageBps) ? data.slippageBps : null,
    contextSlot: slotOrNull(data.contextSlot),
  };
}

/**
 * Sliding-window limiter: at most maxRequests grants in any windowMs span.
 * pauseUntil holds every caller back, which is how one 429 slows the whole
 * sampler rather than only the request that hit it.
 *
 * Two priorities, FIFO within each. Ladder rungs go "high" so a ladder stays
 * as close to one market instant as the cap allows; drift re-quotes go "low"
 * and absorb the waiting instead. That costs drift nothing in honesty, since
 * each drift row records when it was actually re-quoted.
 *
 * Jupiter counts in fixed ten-second windows. A sliding cap of N guarantees
 * no fixed window ever sees more than N, so the two never disagree.
 */
export function createRateLimiter({
  maxRequests,
  windowMs,
  now = Date.now,
  sleep = defaultSleep,
}) {
  if (!(maxRequests >= 1)) throw new Error("maxRequests must be at least 1");

  const grants = [];
  const waiting = { high: [], low: [] };
  let pausedUntil = 0;
  let pumping = false;

  async function pump() {
    if (pumping) return;
    pumping = true;

    try {
      while (waiting.high.length || waiting.low.length) {
        const t = now();

        while (grants.length && grants[0] <= t - windowMs) grants.shift();

        if (t < pausedUntil) {
          await sleep(pausedUntil - t);
          continue;
        }

        if (grants.length >= maxRequests) {
          await sleep(grants[0] + windowMs - t);
          continue;
        }

        grants.push(t);
        (waiting.high.shift() ?? waiting.low.shift())();
      }
    } finally {
      pumping = false;
    }
  }

  return {
    acquire(priority = "high") {
      return new Promise((resolve) => {
        waiting[priority === "low" ? "low" : "high"].push(resolve);
        pump();
      });
    },
    pauseUntil(ms) {
      pausedUntil = Math.max(pausedUntil, ms);
    },
    get pausedUntil() {
      return pausedUntil;
    },
  };
}

export const DEFAULT_RETRY = {
  maxRateLimitRetries: 5,
  maxTransientRetries: 2,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  timeoutMs: 10_000,
};

/** Exponential delay for attempt n (0-based), capped, with up to 20% jitter. */
export function backoffDelayMs(attempt, retry, random = Math.random) {
  const exp = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
  return Math.round(exp * (1 + 0.2 * random()));
}

/**
 * GETs JSON through the limiter, retrying 429s and transient failures.
 * Never throws: every outcome comes back as { ok: true, ... } or
 * { ok: false, kind, ... } so one bad request can never take a loop down.
 *
 * kind is one of rate_limited, no_route, http, network, invalid.
 * latencyMs is the successful attempt alone, not the time spent backing off.
 */
export async function getJson({
  url,
  apiKey,
  priority = "high",
  fetchImpl = fetch,
  limiter,
  retry = DEFAULT_RETRY,
  now = Date.now,
  sleep = defaultSleep,
  random = Math.random,
  onEvent = () => {},
}) {
  let rateLimitedAttempts = 0;
  let transientAttempts = 0;

  for (;;) {
    await limiter.acquire(priority);

    const startedAt = now();
    let response;

    try {
      response = await fetchImpl(url, {
        headers: apiKey ? { "x-api-key": apiKey } : undefined,
        signal: AbortSignal.timeout(retry.timeoutMs),
      });
    } catch (error) {
      onEvent("network");

      if (transientAttempts < retry.maxTransientRetries) {
        await sleep(backoffDelayMs(transientAttempts++, retry, random));
        continue;
      }

      return {
        ok: false,
        kind: "network",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const receivedAt = now();

    if (response.status === 429) {
      if (rateLimitedAttempts >= retry.maxRateLimitRetries) {
        onEvent("rate_limited", { attempt: rateLimitedAttempts, gaveUp: true });
        return { ok: false, kind: "rate_limited", status: 429 };
      }

      let delay = backoffDelayMs(rateLimitedAttempts, retry, random);

      // Jupiter says when its window resets. Waiting for that is never worse
      // than the exponential guess, so whichever is later wins, still capped.
      const reset = Number(response.headers?.get?.("x-ratelimit-reset"));
      if (Number.isFinite(reset) && reset > 0) {
        delay = Math.min(retry.maxDelayMs, Math.max(delay, reset * 1000 - now()));
      }

      limiter.pauseUntil(now() + delay);
      onEvent("rate_limited", { attempt: rateLimitedAttempts, delayMs: delay, gaveUp: false });
      rateLimitedAttempts++;
      continue;
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (response.status >= 500) {
      onEvent("http");

      if (transientAttempts < retry.maxTransientRetries) {
        await sleep(backoffDelayMs(transientAttempts++, retry, random));
        continue;
      }

      return { ok: false, kind: "http", status: response.status, body };
    }

    if (response.status >= 400) {
      const code = String(body?.errorCode ?? "");
      const kind = /ROUTE/i.test(code) ? "no_route" : "http";
      onEvent(kind);
      return { ok: false, kind, status: response.status, body };
    }

    if (body === null) {
      onEvent("invalid");
      return { ok: false, kind: "invalid", status: response.status };
    }

    return { ok: true, data: body, latencyMs: receivedAt - startedAt, receivedAt };
  }
}

export function quoteUrl(baseUrl, { inputMint, outputMint, amount, slippageBps }) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
    ...QUOTE_PARAMS,
  });
  return `${baseUrl}/swap/v1/quote?${params}`;
}

export function priceUrl(baseUrl, mints) {
  return `${baseUrl}/price/v3?ids=${mints.join(",")}`;
}

/** { mint: usdPrice } from a Jupiter price v3 body, dropping anything unusable. */
export function parsePrices(body) {
  const prices = {};
  for (const [mint, entry] of Object.entries(body ?? {})) {
    const price = Number(entry?.usdPrice);
    if (Number.isFinite(price) && price > 0) prices[mint] = price;
  }
  return prices;
}

/**
 * Tokens whose configured decimals disagree with what Jupiter reports. A
 * wrong decimals value would scale every amount for that token by a power
 * of ten, so a pair touching one of these must not be sampled at all.
 */
export function decimalsMismatches(body, tokens = Object.values(TOKENS)) {
  return tokens.filter((t) => {
    const reported = body?.[t.mint]?.decimals;
    return Number.isInteger(reported) && reported !== t.decimals;
  });
}

/**
 * Turns the successful rungs of one ladder into QuoteSample rows.
 *
 * Impact is measured against rung IMPACT_BASELINE_RUNG (1, about $25) of
 * this same ladder, not rung 0. Rung 0 is a ~$5 trade that often routes
 * through a different venue from everything above it, which made larger
 * rungs look cheaper than the smallest one. Rung 0 is still recorded, and
 * gets an impact figure against rung 1 like every other rung.
 *
 * The baseline's own route is stored on every row, so a P3 model can tell an
 * impact that comes from size apart from one that comes from a route change.
 * If the baseline rung did not come back there is no reference, and impact
 * stays null rather than being guessed from another instant.
 *
 * notionalUsd is the input valued at the USD prices passed in, which are the
 * ones the ladder was sized with.
 */
export function buildLadderRows({
  pair,
  ladderId,
  rungs,
  makeId,
  usdPrices,
  baselineRung = IMPACT_BASELINE_RUNG,
}) {
  const reference = rungs.find((r) => r.rung === baselineRung);
  const referencePrice = reference
    ? effectivePrice(
        reference.quote.inAmount,
        reference.quote.outAmount,
        pair.input.decimals,
        pair.output.decimals,
      )
    : null;

  return rungs.map(({ id, rung, quote, sampledAt, latencyMs, requestedSlippageBps }) => {
    const price = effectivePrice(
      quote.inAmount,
      quote.outAmount,
      pair.input.decimals,
      pair.output.decimals,
    );

    return {
      // A rung can be given its id up front, so drift re-quotes can be
      // scheduled against it before the ladder as a whole is written.
      id: id ?? makeId(),
      sampledAt: new Date(sampledAt),
      pair: pair.label,
      inputMint: pair.input.mint,
      outputMint: pair.output.mint,
      inAmountBaseUnits: quote.inAmount,
      outAmountBaseUnits: quote.outAmount,
      effectivePrice: effectivePriceDecimal(
        quote.inAmount,
        quote.outAmount,
        pair.input.decimals,
        pair.output.decimals,
      ),
      reportedImpactPct:
        quote.reportedImpactPct === null
          ? null
          : decimalString(quote.reportedImpactPct, 12),
      measuredImpactBps:
        referencePrice === null
          ? null
          : decimalString(degradationBps(referencePrice, price), 6),
      routeLabels: quote.routeLabels,
      baselineRouteLabels: reference ? reference.quote.routeLabels : [],
      notionalUsd: decimalString(notionalUsd(pair.input, quote.inAmount, usdPrices), 6),
      notionalSource: "price_v3",
      hopCount: quote.hopCount,
      slippageBps: quote.slippageBps ?? requestedSlippageBps,
      contextSlot: quote.contextSlot,
      apiLatencyMs: latencyMs,
      ladderId,
      ladderRung: rung,
    };
  });
}

/** One QuoteDrift row: the origin's exact input asked again later. */
export function buildDriftRow({ origin, pair, delaySeconds, quote, requotedAt, latencyMs, makeId }) {
  const originPrice = Number(origin.effectivePrice);
  const price = effectivePrice(
    quote.inAmount,
    quote.outAmount,
    pair.input.decimals,
    pair.output.decimals,
  );

  return {
    id: makeId(),
    originSampleId: origin.id,
    delaySeconds,
    requotedAt: new Date(requotedAt),
    outAmountBaseUnits: quote.outAmount,
    effectivePrice: effectivePriceDecimal(
      quote.inAmount,
      quote.outAmount,
      pair.input.decimals,
      pair.output.decimals,
    ),
    driftBps: decimalString(degradationBps(originPrice, price), 6),
    actualElapsedMs: Math.round(requotedAt - origin.sampledAt.getTime()),
    apiLatencyMs: latencyMs,
    contextSlot: quote.contextSlot,
  };
}

/**
 * How late a drift re-quote may land and still be recorded under its nominal
 * delay: the larger of 2 s and a quarter of the delay. A +5 s re-quote taken
 * at +10 s is a different horizon, not a slightly late one, so the floor is
 * kept tight; missing a +5 s row is better than mislabelling one.
 */
export function driftToleranceMs(delaySeconds) {
  return Math.max(2_000, delaySeconds * 250);
}

/**
 * Whether a re-quote at atMs still counts as "delaySeconds after the origin".
 * A row labelled +5 s that was really taken a minute later, because the
 * machine slept or the queue backed up, would silently corrupt every drift
 * horizon trained on it, so anything outside tolerance is not recorded.
 */
export function isDriftOnTime(originMs, delaySeconds, atMs) {
  const lateBy = atMs - (originMs + delaySeconds * 1000);
  return lateBy <= driftToleranceMs(delaySeconds);
}

/**
 * Whether a rung answered too long after its ladder was fired to describe the
 * same market instant. Such a rung is dropped rather than measured against a
 * rung 0 from a different moment.
 */
export function ladderTooStale(firstSampledAtMs, nowMs, maxSpanMs) {
  return nowMs - firstSampledAtMs > maxSpanMs;
}

/**
 * Whether ladder number n of pair index i gets drift re-quotes. Offsetting by
 * the pair index spreads the drifted ladders across the cycle instead of
 * landing every pair's drift in the same minute.
 */
export function isDriftLadder(ladderNumber, pairIndex, every) {
  if (!(every >= 1)) return false;
  return (ladderNumber + pairIndex) % every === 0;
}

/**
 * Whether drift set n of pair index i also re-quotes the large rung. Roughly
 * one set in `every` does, which is enough to test whether drift really is
 * independent of size rather than assuming it.
 */
export function isLargeDriftSet(driftSetNumber, pairIndex, every) {
  if (!(every >= 1)) return false;
  return (driftSetNumber + pairIndex) % every === 0;
}

export function parseNumberList(raw, fallback) {
  if (!raw) return fallback;
  const values = raw.split(",").map((v) => Number(v.trim()));
  if (!values.length || values.some((v) => !Number.isFinite(v))) {
    throw new Error(`Not a list of numbers: "${raw}"`);
  }
  return values;
}
