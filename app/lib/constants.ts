import { Connection } from "@solana/web3.js";

const TOKEN_PRICE_REFRESH_RATE = 60_000;

let LAST_UPDATED: number | null = null;

type JupiterPrice = {
    usdPrice: number;
    blockId: number;
    decimals: number;
    priceChange24h: number;
};

let prices: Record<string, JupiterPrice> = {};

export interface TokenDetails {
    name :string,
    mint :string,
    native :boolean,
    image:string,
    price?: string,
    decimals: number
}

export const SUPPORTED_TOKENS = [
    {
        name: "USDC",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        native: false,
        image :"/tokens/USDC.png",
        decimals : 6
    },
    {
        name: "USDT",
        mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        native: false,
        image :"/tokens/USDT.png",
        decimals : 6
    },
    {
        name: "SOL",
        mint: "So11111111111111111111111111111111111111112",
        native: true,
        image :"/tokens/Sol.png",
        decimals : 9
    },
] as const;

export type SupportedToken = typeof SUPPORTED_TOKENS[number];


export const connection = new Connection("https://api.mainnet-beta.solana.com");

export async function getSupportedTokens() {
  const apiKey = process.env.JUP_API_KEY;
  if (!apiKey) throw new Error("JUP_API_KEY missing");

  if (!LAST_UPDATED || Date.now() - LAST_UPDATED > TOKEN_PRICE_REFRESH_RATE) {
    const ids = SUPPORTED_TOKENS.map(t => t.mint).join(",");

    const response = await fetch(
      `https://api.jup.ag/price/v3?ids=${ids}`,
      {
        headers: {
          "x-api-key": apiKey,
        },
      }
    );

    const data = await response.json();

    prices = data ?? {};

    LAST_UPDATED = Date.now();
  }

  return SUPPORTED_TOKENS.map(t => ({
    ...t,
    price: prices[t.mint]?.usdPrice ?? 0
  }));
}



getSupportedTokens()