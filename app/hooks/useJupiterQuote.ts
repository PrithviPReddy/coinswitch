import { useEffect, useState } from 'react';
import axios from 'axios';
import { SupportedToken } from '../lib/constants';

export function useJupiterQuote(
  { baseAsset, quoteAsset, baseAmount }: {
    baseAsset: SupportedToken;
    quoteAsset: SupportedToken;
    baseAmount: string;
  }
) {
  const [quoteAmount, setQuoteAmount] = useState<string | null>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!baseAmount) return;

    const timeoutId = setTimeout(async () => {
      try {
        setLoading(true);

        const amount = Math.round(
          Number(baseAmount) * Math.pow(10, baseAsset.decimals)
        );

        const response = await axios.get('/api/quote', {
          params: {
            inputMint: baseAsset.mint,
            outputMint: quoteAsset.mint,
            amount,
          },
        });

        const finalAmount =
          Number(response.data.outAmount) /
          Math.pow(10, quoteAsset.decimals);

        setQuoteAmount(finalAmount.toString());
      } catch (error) {
        console.error('Quote fetch failed', error);
      } finally {
        setLoading(false);
      }
    }, 500); // debounce

    return () => clearTimeout(timeoutId);
  }, [baseAmount, baseAsset, quoteAsset]);

  return { quoteAmount, setQuoteAmount,loading };
}
