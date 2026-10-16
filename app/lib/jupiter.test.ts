import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { QuoteError, fetchQuote, parseQuoteResponse } from "./jupiter";

// A real mainnet response recorded on 2026-10-16. No test calls the network.
const QUOTE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../scripts/sampler/__fixtures__/quote-sol-usdc-1sol.json"),
    "utf8",
  ),
);

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ASK = { inputMint: SOL, outputMint: USDC, amount: BigInt(1_000_000_000), slippageBps: 50 };

function scripted(responses: Array<Response | Error>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const noWait = { sleep: async () => {}, apiKey: "k" };

describe("parseQuoteResponse", () => {
  const timing = { quotedAt: new Date(0), latencyMs: 12 };

  it("reads the fields a swap is settled and recorded on", () => {
    const q = parseQuoteResponse(QUOTE, ASK, timing);
    expect(q).toMatchObject({
      inAmount: BigInt(1_000_000_000),
      outAmount: BigInt(105_023_201),
      otherAmountThreshold: BigInt(104_498_085),
      slippageBps: 50,
      contextSlot: 457496607,
      routeLabels: ["Kipseli"],
      latencyMs: 12,
    });
  });

  it("refuses a response for a different pair or size than was asked", () => {
    expect(() => parseQuoteResponse(QUOTE, { ...ASK, outputMint: "other" }, timing)).toThrow(QuoteError);
    expect(() => parseQuoteResponse(QUOTE, { ...ASK, amount: BigInt(2) }, timing)).toThrow(QuoteError);
  });
});

describe("fetchQuote", () => {
  it("retries a 429 once and then returns the quote", async () => {
    const { fetchImpl, calls } = scripted([json(429, {}), json(200, QUOTE)]);
    const q = await fetchQuote({ ...ASK, ...noWait, fetchImpl });
    expect(q.outAmount).toBe(BigInt(105_023_201));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("swapMode=ExactIn");
    expect(calls[0]).toContain("slippageBps=50");
  });

  it("gives up after a second 429 with a rate-limit error", async () => {
    const { fetchImpl } = scripted([json(429, {}), json(429, {})]);
    await expect(fetchQuote({ ...ASK, ...noWait, fetchImpl })).rejects.toMatchObject({
      kind: "rate_limited",
    });
  });

  it("reports no route distinctly", async () => {
    const { fetchImpl } = scripted([json(400, { error: "No routes found", errorCode: "NO_ROUTES_FOUND" })]);
    await expect(fetchQuote({ ...ASK, ...noWait, fetchImpl })).rejects.toMatchObject({
      kind: "no_route",
    });
  });

  it("reports a network failure as unavailable", async () => {
    const { fetchImpl } = scripted([new Error("ECONNRESET")]);
    await expect(fetchQuote({ ...ASK, ...noWait, fetchImpl })).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
