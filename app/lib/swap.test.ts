import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { decideFill } from "./fill";
import { parseQuoteResponse, type Quote } from "./jupiter";
import { SettlementNotAppliedError, SettlementUncertainError } from "./devnet";
import { SLIPPAGE_BOUND_REASON, executeSwap, parseSwapRequest, type SwapDeps } from "./swap";

// A real mainnet response recorded on 2026-10-16: 1 SOL -> 105.023201 USDC.
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../scripts/sampler/__fixtures__/quote-sol-usdc-1sol.json"),
    "utf8",
  ),
);

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SERVER_QUOTE: Quote = parseQuoteResponse(
  RECORDED,
  { inputMint: SOL, outputMint: USDC, amount: BigInt(1_000_000_000) },
  { quotedAt: new Date("2026-10-16T10:00:00Z"), latencyMs: 85 },
);

const BODY = {
  walletId: "w1",
  inputMint: SOL,
  outputMint: USDC,
  inAmountBaseUnits: "1000000000",
  slippageBps: 50,
};

/** Records every write, and lets each test script settlement. */
function harness(overrides: Partial<SwapDeps> = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const settleCalls: Array<{ outBaseUnits: bigint; inBaseUnits: bigint }> = [];
  const quoteCalls: unknown[] = [];
  let balance = BigInt(0);

  const deps: SwapDeps = {
    fetchQuote: async (args) => {
      quoteCalls.push(args);
      return SERVER_QUOTE;
    },
    decideFill: ({ quote, slippageBps }) =>
      decideFill({ quotedOut: quote.outAmount, slippageBps, mode: "exact" }),
    readBalance: async () => balance,
    settleSwap: async (args) => {
      settleCalls.push({ outBaseUnits: args.outBaseUnits, inBaseUnits: args.inBaseUnits });
      await args.onSigned?.("SIG111");
      balance += args.outBaseUnits;
      return "SIG111";
    },
    swaps: {
      create: async (data) => {
        rows.set("s1", { status: "Pending", ...data });
        return { id: "s1" };
      },
      update: async (id, data) => {
        rows.set(id, { ...rows.get(id), ...data });
      },
    },
    ...overrides,
  };

  return { deps, rows, settleCalls, quoteCalls };
}

function run(deps: SwapDeps, body: unknown = BODY) {
  const parsed = parseSwapRequest(body);
  if (!parsed.ok) throw new Error(parsed.message);
  const kp = Keypair.generate();
  return executeSwap(deps, {
    userId: "u1",
    wallet: { id: "w1" },
    owner: kp.publicKey,
    userKeypair: kp,
    request: parsed.request,
  });
}

describe("parseSwapRequest", () => {
  it("reads only the five allowed fields", () => {
    const parsed = parseSwapRequest({
      ...BODY,
      quoteResponse: { outAmount: "999999999999999" },
      outAmount: "999999999999999",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.keys(parsed.request).sort()).toEqual(
        ["inAmountBaseUnits", "inputToken", "outputToken", "slippageBps", "walletId"],
      );
    }
  });

  it("refuses what it cannot settle", () => {
    const bad = [
      { ...BODY, outputMint: SOL },
      { ...BODY, inputMint: "NotAMint" },
      { ...BODY, inAmountBaseUnits: "0" },
      { ...BODY, inAmountBaseUnits: 1000 },
      { ...BODY, inAmountBaseUnits: "1.5" },
      { ...BODY, slippageBps: 0 },
      { ...BODY, slippageBps: 5000 },
      { ...BODY, slippageBps: 12.5 },
    ];
    for (const body of bad) expect(parseSwapRequest(body).ok, JSON.stringify(body)).toBe(false);
  });
});

describe("executeSwap", () => {
  it("ignores a forged quote and settles against the server's own", async () => {
    const { deps, settleCalls, quoteCalls, rows } = harness();

    const result = await run(deps, {
      ...BODY,
      // What an attacker would send: a quote promising a fortune.
      quoteResponse: { ...RECORDED, outAmount: "999999999999999", inAmount: "1" },
    });

    expect(result.status).toBe(200);
    expect(quoteCalls).toEqual([
      { inputMint: SOL, outputMint: USDC, amount: BigInt(1_000_000_000), slippageBps: 50 },
    ]);
    expect(settleCalls).toEqual([
      { inBaseUnits: BigInt(1_000_000_000), outBaseUnits: BigInt(105_023_201) },
    ]);
    expect(rows.get("s1")).toMatchObject({
      status: "Settled",
      quotedOut: 105.023201,
      settledOut: 105.023201,
      signature: "SIG111",
      inputMint: SOL,
      outputMint: USDC,
      quotedAt: new Date("2026-10-16T10:00:00Z"),
      quoteLatencyMs: 85,
      contextSlot: 457496607,
      otherAmountThreshold: "104498085",
    });
  });

  it("records a fill below the slippage cap as Failed and never settles it", async () => {
    const { deps, settleCalls, rows } = harness({
      decideFill: ({ quote, slippageBps }) =>
        decideFill({ quotedOut: quote.outAmount, slippageBps, mode: "simulated", shortfallBps: 80 }),
    });

    const result = await run(deps);

    expect(result.status).toBe(409);
    expect(settleCalls).toHaveLength(0);
    expect(rows.get("s1")).toMatchObject({ status: "Failed", failureReason: SLIPPAGE_BOUND_REASON });
  });

  it("leaves a timed-out swap Pending with its signature, never Failed", async () => {
    const { deps, rows } = harness({
      settleSwap: async (args) => {
        await args.onSigned?.("SIG_TIMEOUT");
        throw new SettlementUncertainError("Timed out waiting for SIG_TIMEOUT.", "SIG_TIMEOUT");
      },
    });

    const result = await run(deps);

    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ status: "Pending", signature: "SIG_TIMEOUT" });
    expect(rows.get("s1")).toMatchObject({ status: "Pending", signature: "SIG_TIMEOUT" });
    expect(rows.get("s1")?.failureReason).toBeUndefined();
  });

  it("treats any unexpected error after signing as uncertain too", async () => {
    const { deps, rows } = harness({
      settleSwap: async (args) => {
        await args.onSigned?.("SIG_DROP");
        throw new Error("socket hang up");
      },
    });

    const result = await run(deps);
    expect(result.status).toBe(202);
    expect(rows.get("s1")).toMatchObject({ status: "Pending", signature: "SIG_DROP" });
  });

  it("marks Failed, keeping the signature, when the chain says it did not apply", async () => {
    const { deps, rows } = harness({
      settleSwap: async (args) => {
        await args.onSigned?.("SIG_ERR");
        throw new SettlementNotAppliedError("Transaction SIG_ERR failed on chain");
      },
    });

    const result = await run(deps);
    expect(result.status).toBe(502);
    expect(rows.get("s1")).toMatchObject({ status: "Failed", signature: "SIG_ERR" });
  });

  it("marks Failed with no signature when it fails before signing", async () => {
    const { deps, rows } = harness({
      settleSwap: async () => {
        throw new Error("The vault is out of devnet SOL");
      },
    });

    const result = await run(deps);
    expect(result.status).toBe(502);
    expect(rows.get("s1")).toMatchObject({ status: "Failed" });
    expect(rows.get("s1")?.signature).toBeUndefined();
  });

  it("stays Settled when it confirmed and only the read-back failed", async () => {
    let reads = 0;
    const { deps, rows } = harness({
      readBalance: async () => {
        if (reads++ > 0) throw new Error("RPC down");
        return BigInt(0);
      },
    });

    const result = await run(deps);
    expect(result.status).toBe(200);
    expect(rows.get("s1")).toMatchObject({ status: "Settled", settledOut: null, signature: "SIG111" });
  });

  it("writes nothing when there is no quote to settle against", async () => {
    const { deps, rows } = harness({
      fetchQuote: async () => {
        throw new Error("down");
      },
    });

    const result = await run(deps);
    expect(result.status).toBe(502);
    expect(rows.size).toBe(0);
  });
});
