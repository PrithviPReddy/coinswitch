import { Connection } from "@solana/web3.js";

/**
 * The project runs against two Solana clusters at once, on purpose.
 *
 *   mainnet  - read only. Jupiter's routers live here, so this is the only
 *              place a quote reflects real liquidity and real price impact.
 *   devnet   - where value actually moves. Settlement happens against tokens
 *              this project mints itself, so every swap produces a signature
 *              that resolves on Solscan.
 *
 * Quoting and settling are deliberately not the same network. Jupiter's
 * program is deployed on devnet under the same address, but nothing has
 * liquidity there and almost every pair comes back with no route, so a
 * devnet quote would be an empty response rather than a cheaper one.
 */

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
  name: string;
  mint: string;
  devnetMint: string;
  native: boolean;
  image: string;
  price?: number;
  decimals: number;
  /** The environment variable devnetMint comes from, for error messages. */
  devnetMintEnv?: string;
  /**
   * "thin" for the mid-caps whose mainnet liquidity is a few million dollars,
   * where size costs real money; "deep" for SOL and the stablecoins.
   */
  depth: "deep" | "thin";
}

/**
 * Devnet mint addresses are created by `npm run setup:devnet` and written into
 * the environment. A missing or malformed one is reported by name at first
 * use (requireDevnetMint in devnet.ts), not as a bare key-parsing error.
 *
 * Every token except SOL is a devnet stand-in this project mints itself. The
 * mainnet mint beside it is only ever used to ask Jupiter for a price; no
 * real USDC, JUP, BONK or WIF is ever touched.
 */
const DEVNET_USDC_MINT = process.env.DEVNET_USDC_MINT ?? "";
const DEVNET_USDT_MINT = process.env.DEVNET_USDT_MINT ?? "";
const DEVNET_JUP_MINT = process.env.DEVNET_JUP_MINT ?? "";
const DEVNET_BONK_MINT = process.env.DEVNET_BONK_MINT ?? "";
const DEVNET_WIF_MINT = process.env.DEVNET_WIF_MINT ?? "";

export const SUPPORTED_TOKENS: TokenDetails[] = [
  {
    name: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    devnetMint: DEVNET_USDC_MINT,
    devnetMintEnv: "DEVNET_USDC_MINT",
    native: false,
    image: "/tokens/USDC.png",
    decimals: 6,
    depth: "deep",
  },
  {
    name: "USDT",
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    devnetMint: DEVNET_USDT_MINT,
    devnetMintEnv: "DEVNET_USDT_MINT",
    native: false,
    image: "/tokens/USDT.png",
    decimals: 6,
    depth: "deep",
  },
  {
    name: "SOL",
    mint: "So11111111111111111111111111111111111111112",
    devnetMint: "So11111111111111111111111111111111111111112",
    native: true,
    image: "/tokens/Sol.png",
    decimals: 9,
    depth: "deep",
  },
  // Decimals match the mainnet mints (read on chain, 2026-10-16), so a
  // mainnet quote's base units settle on devnet unchanged.
  {
    name: "JUP",
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    devnetMint: DEVNET_JUP_MINT,
    devnetMintEnv: "DEVNET_JUP_MINT",
    native: false,
    image: "/tokens/default.svg",
    decimals: 6,
    depth: "thin",
  },
  {
    name: "BONK",
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    devnetMint: DEVNET_BONK_MINT,
    devnetMintEnv: "DEVNET_BONK_MINT",
    native: false,
    image: "/tokens/default.svg",
    decimals: 5,
    depth: "thin",
  },
  {
    name: "WIF",
    mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    devnetMint: DEVNET_WIF_MINT,
    devnetMintEnv: "DEVNET_WIF_MINT",
    native: false,
    image: "/tokens/default.svg",
    decimals: 6,
    depth: "thin",
  },
];

/** What a selector should call a token, so nobody mistakes a stand-in for the real thing. */
export function tokenLabel(token: TokenDetails): string {
  return token.native ? `${token.name} (devnet)` : `${token.name} (devnet stand-in)`;
}

export type SupportedToken = TokenDetails;

export function tokenByMint(mint: string): TokenDetails | undefined {
  return SUPPORTED_TOKENS.find((t) => t.mint === mint);
}

export const MAINNET_RPC =
  process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";

export const DEVNET_RPC =
  process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";

/** Quotes and USD prices only. Nothing is ever signed against this. */
export const mainnetConnection = new Connection(MAINNET_RPC, "confirmed");

/** Balances and settlement. Every signature the UI links to comes from here. */
export const devnetConnection = new Connection(DEVNET_RPC, "confirmed");

export const DEFAULT_SLIPPAGE_BPS = Number(
  process.env.NEXT_PUBLIC_SLIPPAGE_BPS ?? 50,
);

export function explorerTxUrl(signature: string) {
  return `https://solscan.io/tx/${signature}?cluster=devnet`;
}

export function explorerAddressUrl(address: string) {
  return `https://solscan.io/account/${address}?cluster=devnet`;
}

export async function getSupportedTokens(): Promise<TokenDetails[]> {
  const apiKey = process.env.JUP_API_KEY;

  if (!LAST_UPDATED || Date.now() - LAST_UPDATED > TOKEN_PRICE_REFRESH_RATE) {
    try {
      const ids = SUPPORTED_TOKENS.map((t) => t.mint).join(",");

      const response = await fetch(`https://api.jup.ag/price/v3?ids=${ids}`, {
        headers: apiKey ? { "x-api-key": apiKey } : undefined,
      });

      if (response.ok) {
        prices = (await response.json()) ?? {};
        LAST_UPDATED = Date.now();
      }
    } catch {
      // A price outage degrades the USD column but must not take the swap
      // flow down with it. Last known prices stay in place.
    }
  }

  return SUPPORTED_TOKENS.map((t) => ({
    ...t,
    price: prices[t.mint]?.usdPrice ?? 0,
  }));
}
