import { NextResponse } from "next/server";
import axios from "axios";
import { DEFAULT_SLIPPAGE_BPS } from "@/app/lib/constants";

/**
 * Quotes come from Jupiter on mainnet. That is the whole point of quoting
 * here rather than on devnet: mainnet is where the liquidity that determines
 * price impact actually sits.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const amount = searchParams.get("amount");

  if (!amount || Number(amount) <= 0) {
    return NextResponse.json({ error: "Enter an amount" }, { status: 400 });
  }

  try {
    const response = await axios.get("https://api.jup.ag/swap/v1/quote", {
      params: {
        inputMint: searchParams.get("inputMint"),
        outputMint: searchParams.get("outputMint"),
        amount,
        slippageBps: searchParams.get("slippageBps") ?? DEFAULT_SLIPPAGE_BPS,
        swapMode: "ExactIn",
        restrictIntermediateTokens: true,
        maxAccounts: 64,
      },
      headers: process.env.JUP_API_KEY
        ? { "x-api-key": process.env.JUP_API_KEY }
        : undefined,
      timeout: 10_000,
    });

    return NextResponse.json(response.data);
  } catch (error) {
    const detail =
      axios.isAxiosError(error) && error.response?.status === 429
        ? "Jupiter is rate limiting this key. Wait a moment and retry."
        : "Could not reach Jupiter for a quote.";

    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
