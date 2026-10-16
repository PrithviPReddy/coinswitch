import { NextResponse } from "next/server";
import { DEFAULT_ADVISOR_PARAMS, advise, type Candidate } from "@/app/lib/advisor";
import { DEFAULT_SLIPPAGE_BPS, getSupportedTokens, tokenByMint } from "@/app/lib/constants";
import { resolvePair } from "@/app/lib/costModel";
import { loadCostModel } from "@/app/lib/costModelRuntime";
import { currentVolatility } from "@/app/lib/fillRuntime";
import { parseSlippageBps } from "@/app/lib/swap";

/**
 * Execution advice for an order, from the cost model. Read only: it prices
 * modes and returns them, it never executes anything.
 *
 *   GET /api/advice?inputMint=&outputMint=&amount=<base units>[&slippageBps=]
 *
 * The app itself executes a single order; this is what the advisor would do
 * and what each alternative was predicted to cost.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const input = tokenByMint(searchParams.get("inputMint") ?? "");
  const output = tokenByMint(searchParams.get("outputMint") ?? "");
  const amount = searchParams.get("amount") ?? "";

  if (!input || !output || input.mint === output.mint) {
    return NextResponse.json({ error: "Pick two different supported tokens" }, { status: 400 });
  }
  if (!/^\d+$/.test(amount) || BigInt(amount) === BigInt(0)) {
    return NextResponse.json({ error: "Enter an amount" }, { status: 400 });
  }
  const capBps = parseSlippageBps(searchParams.get("slippageBps") ?? DEFAULT_SLIPPAGE_BPS);
  if (capBps === null) return NextResponse.json({ error: "Slippage is out of range" }, { status: 400 });

  const loaded = loadCostModel();
  if (!loaded.model) return NextResponse.json({ error: `Advice unavailable: ${loaded.error}` }, { status: 503 });
  const model = loaded.model;

  const priced = (await getSupportedTokens()).find((t) => t.mint === input.mint);
  const price = priced?.price ?? 0;
  if (!(price > 0)) {
    return NextResponse.json({ error: `No mainnet price for ${input.name} right now, so the order cannot be valued.` }, { status: 503 });
  }
  const notionalUsd = (Number(amount) / 10 ** input.decimals) * price;

  const pair = `${input.name}/${output.name}`;
  const { source } = resolvePair(model, pair);
  const volatility = source ? await currentVolatility(source) : null;

  const advice = advise(model, { pair, notionalUsd, capBps, volatility }, DEFAULT_ADVISOR_PARAMS);

  const summarise = (c: Candidate) => ({
    mode: c.mode,
    params: c.params,
    totalBps: c.cost.totalBps,
    structuralBps: c.cost.structuralBps,
    transientBps: c.cost.transientBps,
    impactBps: c.cost.impactBps,
    driftBps: c.cost.executionDriftBps + c.cost.waitingDriftBps,
    failureProbability: c.cost.failureProbability,
    feeBps: c.cost.feeBps,
    coverage: c.coverage,
    lowConfidence: c.lowConfidence,
    eligible: c.eligible,
    ineligibleReason: c.ineligibleReason,
  });

  return NextResponse.json({
    pair,
    notionalUsd,
    capBps,
    volatility,
    mode: advice.mode,
    best: summarise(advice.best),
    alternatives: Object.values(advice.byMode).map(summarise),
    fillGate: advice.fillGate,
    structuralShare: advice.structuralShare,
    explanation: advice.explanation,
    splitAtGridBoundary: advice.splitAtGridBoundary,
    lowConfidence: advice.lowConfidence,
    recoveryAssumed: advice.recoveryFraction,
    deferEnabled: DEFAULT_ADVISOR_PARAMS.deferEnabled,
    model: { version: model.modelVersion, producer: model.producer, exampleOnly: loaded.exampleOnly },
  });
}
