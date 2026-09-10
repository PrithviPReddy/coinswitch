import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { SupportedToken } from "../lib/constants";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type QuoteState = {
  outAmount: number;
  priceImpactPct: number | null;
  routeLabels: string[];
  raw: any;
};

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

  useEffect(() => {
    if (!baseAmount || Number(baseAmount) <= 0) {
      setQuote(null);
      setError(null);
      return;
    }

    const id = ++requestId.current;

    const timeoutId = setTimeout(async () => {
      setLoading(true);
      setError(null);

      try {
        const amount = Math.round(
          Number(baseAmount) * Math.pow(10, baseAsset.decimals),
        );

        const response = await axios.get("/api/quote", {
          params: {
            inputMint: baseAsset.mint,
            outputMint: quoteAsset.mint,
            amount,
          },
        });

        if (id !== requestId.current) return;

        const data = response.data;

        setQuote({
          outAmount:
            Number(data.outAmount) / Math.pow(10, quoteAsset.decimals),
          priceImpactPct:
            data.priceImpactPct === undefined
              ? null
              : Number(data.priceImpactPct),
          routeLabels: Array.isArray(data.routePlan)
            ? data.routePlan
                .map((leg: any) => leg?.swapInfo?.label)
                .filter(Boolean)
            : [],
          raw: data,
        });
      } catch (err) {
        if (id !== requestId.current) return;
        setQuote(null);
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
  }, [baseAmount, baseAsset, quoteAsset]);

  return { quote, setQuote, loading, error };
}
