import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { SupportedToken } from "../lib/constants";
import { decimalToBaseUnits, quoteKey } from "../lib/amounts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type QuoteState = {
  /** What this quote was asked for: pair and exact input size. */
  key: string;
  inAmountBaseUnits: string;
  outAmount: number;
  priceImpactPct: number | null;
  routeLabels: string[];
  raw: any;
};

/**
 * A display quote for the current pair and amount.
 *
 * The held quote is cleared the moment the pair or amount changes, and
 * `current` is true only while the quote on screen was fetched for exactly
 * what is selected now. The swap button keys off `current`, so it can never
 * act on a quote left over from a different pair.
 *
 * The server re-quotes for itself when the swap is submitted; this one is
 * never sent back.
 */
export function useJupiterQuote({
  baseAsset,
  quoteAsset,
  baseAmount,
}: {
  baseAsset: SupportedToken;
  quoteAsset: SupportedToken;
  baseAmount: string | null | undefined;
}) {
  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against a slow early request overwriting a fast later one.
  const requestId = useRef(0);

  const amount = baseAmount ? decimalToBaseUnits(baseAmount, baseAsset.decimals) : null;
  const key = quoteKey(baseAsset.mint, quoteAsset.mint, amount);

  useEffect(() => {
    const id = ++requestId.current;

    // Whatever was on screen belongs to the previous inputs.
    setQuote(null);
    setError(null);

    if (key === null || amount === null) {
      setLoading(false);
      return;
    }

    setLoading(true);

    const timeoutId = setTimeout(async () => {
      try {
        const response = await axios.get("/api/quote", {
          params: {
            inputMint: baseAsset.mint,
            outputMint: quoteAsset.mint,
            amount: amount.toString(),
          },
        });

        if (id !== requestId.current) return;

        const data = response.data;

        setQuote({
          key,
          inAmountBaseUnits: String(data.inAmount),
          outAmount: Number(data.outAmount) / Math.pow(10, quoteAsset.decimals),
          priceImpactPct:
            data.priceImpactPct === undefined ? null : Number(data.priceImpactPct),
          routeLabels: Array.isArray(data.routePlan)
            ? data.routePlan.map((leg: any) => leg?.swapInfo?.label).filter(Boolean)
            : [],
          raw: data,
        });
      } catch (err) {
        if (id !== requestId.current) return;
        setError(
          axios.isAxiosError(err) && err.response?.data?.error
            ? err.response.data.error
            : "Could not fetch a quote",
        );
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 400);

    return () => clearTimeout(timeoutId);
    // key captures the pair and the exact amount; amount and the tokens are
    // read through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = quote !== null && quote.key === key && !loading;

  return { quote: current ? quote : null, current, loading, error };
}
