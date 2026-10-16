import { useCallback, useEffect, useState } from "react";
import axios from "axios";

export type TokenWithBalance = {
  name: string;
  mint: string;
  devnetMint: string;
  image: string;
  price: number;
  balance: number;
  usdBalance: number;
  decimals: number;
  native: boolean;
};

export function useTokens(address: string) {
  const [tokenBalances, setTokenBalances] = useState<{
    totalBalance: number;
    tokens: TokenWithBalance[];
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;

    try {
      const res = await axios.get(`/api/tokens`, { params: { address } });
      setTokenBalances(res.data);
      setError(null);
    } catch (err) {
      setError(
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Could not read balances from devnet.",
      );
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { loading, error, tokenBalances, refresh };
}
