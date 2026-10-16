/**
 * Mainnet Jupiter quotes, fetched by the server.
 *
 * This is the only place a quote the app acts on comes from. /api/swap calls
 * it for itself and settles against what it returns; anything a client sends
 * that looks like a quote is never read. /api/quote uses it too, so the
 * figure on screen and the figure settled are produced the same way.
 *
 * Read only: nothing here signs or sends anything to mainnet.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const JUPITER_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";

const TIMEOUT_MS = 10_000;

/** The longest a single 429 retry will wait for Jupiter's window to reset. */
const MAX_RATE_LIMIT_WAIT_MS = 3_000;

export type Quote = {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Jupiter's own minimum out at the requested slippage. */
  otherAmountThreshold: bigint;
  slippageBps: number;
  priceImpactPct: number | null;
  routeLabels: string[];
  contextSlot: number | null;
  /** When the response arrived, and how long the request took. */
  quotedAt: Date;
  latencyMs: number;
  /** The response as Jupiter sent it, for display only. */
  raw: any;
};

export type QuoteFailure = "rate_limited" | "no_route" | "unavailable" | "invalid";

export class QuoteError extends Error {
  constructor(
    message: string,
    readonly kind: QuoteFailure,
  ) {
    super(message);
    this.name = "QuoteError";
  }
}

const MESSAGES: Record<QuoteFailure, string> = {
  rate_limited: "Jupiter is rate limiting this key. Wait a moment and retry.",
  no_route: "Jupiter has no route for this pair at this size.",
  unavailable: "Could not reach Jupiter for a quote.",
  invalid: "Jupiter returned a quote this app could not read.",
};

const DIGITS = /^\d+$/;

/** Checks a response is a quote for exactly what was asked, then types it. */
export function parseQuoteResponse(
  data: any,
  asked: { inputMint: string; outputMint: string; amount: bigint },
  timing: { quotedAt: Date; latencyMs: number },
): Quote {
  if (
    !data ||
    data.inputMint !== asked.inputMint ||
    data.outputMint !== asked.outputMint ||
    !DIGITS.test(String(data.inAmount)) ||
    !DIGITS.test(String(data.outAmount)) ||
    !DIGITS.test(String(data.otherAmountThreshold)) ||
    BigInt(data.inAmount) !== asked.amount ||
    BigInt(data.outAmount) === BigInt(0)
  ) {
    throw new QuoteError(MESSAGES.invalid, "invalid");
  }

  const impact = Number(data.priceImpactPct);

  return {
    inputMint: data.inputMint,
    outputMint: data.outputMint,
    inAmount: BigInt(data.inAmount),
    outAmount: BigInt(data.outAmount),
    otherAmountThreshold: BigInt(data.otherAmountThreshold),
    slippageBps: Number(data.slippageBps),
    priceImpactPct:
      data.priceImpactPct === undefined || !Number.isFinite(impact) ? null : impact,
    routeLabels: Array.isArray(data.routePlan)
      ? data.routePlan.map((leg: any) => leg?.swapInfo?.label).filter(Boolean)
      : [],
    contextSlot: Number.isInteger(data.contextSlot) ? data.contextSlot : null,
    quotedAt: timing.quotedAt,
    latencyMs: timing.latencyMs,
    raw: data,
  };
}

type FetchQuoteOptions = {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One quote from Jupiter. A 429 is retried once, after waiting for the
 * advertised window reset (capped at a few seconds), because the quote key
 * may be shared with the sampler and a one-window collision should not fail
 * a swap. Anything else fails straight away with a QuoteError.
 */
export async function fetchQuote({
  inputMint,
  outputMint,
  amount,
  slippageBps,
  apiKey = process.env.JUP_API_KEY || undefined,
  fetchImpl = fetch,
  now = Date.now,
  sleep = defaultSleep,
}: FetchQuoteOptions): Promise<Quote> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: String(slippageBps),
    swapMode: "ExactIn",
    restrictIntermediateTokens: "true",
    maxAccounts: "64",
  });
  const url = `${JUPITER_QUOTE_URL}?${params}`;

  for (let attempt = 0; ; attempt++) {
    const startedAt = now();
    let response: Response;

    try {
      response = await fetchImpl(url, {
        headers: apiKey ? { "x-api-key": apiKey } : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      throw new QuoteError(MESSAGES.unavailable, "unavailable");
    }

    const receivedAt = now();

    if (response.status === 429) {
      if (attempt >= 1) throw new QuoteError(MESSAGES.rate_limited, "rate_limited");

      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const untilReset = Number.isFinite(reset) && reset > 0 ? reset * 1000 - now() : 1_000;
      await sleep(Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(250, untilReset)));
      continue;
    }

    let body: any = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const noRoute = /ROUTE/i.test(String(body?.errorCode ?? ""));
      throw new QuoteError(
        noRoute ? MESSAGES.no_route : MESSAGES.unavailable,
        noRoute ? "no_route" : "unavailable",
      );
    }

    return parseQuoteResponse(
      body,
      { inputMint, outputMint, amount },
      { quotedAt: new Date(receivedAt), latencyMs: receivedAt - startedAt },
    );
  }
}
