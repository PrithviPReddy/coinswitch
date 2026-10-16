import { NextResponse } from "next/server";
import { DEFAULT_SLIPPAGE_BPS, tokenByMint } from "@/app/lib/constants";
import { QuoteError, fetchQuote } from "@/app/lib/jupiter";
import { parseSlippageBps } from "@/app/lib/swap";

/**
 * Quotes come from Jupiter on mainnet. That is the whole point of quoting
 * here rather than on devnet: mainnet is where the liquidity that determines
 * price impact actually sits.
 *
 * This quote is for display. /api/swap fetches its own when the user commits,
 * so nothing returned here is ever trusted back from the client.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const inputMint = searchParams.get("inputMint") ?? "";
  const outputMint = searchParams.get("outputMint") ?? "";
  const amount = searchParams.get("amount") ?? "";

  if (!tokenByMint(inputMint) || !tokenByMint(outputMint) || inputMint === outputMint) {
    return NextResponse.json({ error: "Pick two different supported tokens" }, { status: 400 });
  }

  if (!/^\d+$/.test(amount) || BigInt(amount) === BigInt(0)) {
    return NextResponse.json({ error: "Enter an amount" }, { status: 400 });
  }

  const slippageBps = parseSlippageBps(searchParams.get("slippageBps") ?? DEFAULT_SLIPPAGE_BPS);
  if (slippageBps === null) {
    return NextResponse.json({ error: "Slippage is out of range" }, { status: 400 });
  }

  try {
    const quote = await fetchQuote({
      inputMint,
      outputMint,
      amount: BigInt(amount),
      slippageBps,
    });
    return NextResponse.json(quote.raw);
  } catch (error) {
    const message = error instanceof QuoteError ? error.message : "Could not reach Jupiter for a quote.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
