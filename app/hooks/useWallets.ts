import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";

export type Wallet = {
  id: string;
  label: string;
  publicKey: string;
  createdAt: string;
};

/** Survives a reload so a refresh does not silently move you to Wallet 1. */
const STORAGE_KEY = "coinswitch.selectedWalletId";

function readStoredId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private windows and blocked site data throw rather than return null.
    return null;
  }
}

function storeId(id: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Losing the preference is survivable; failing the render is not.
  }
}

/**
 * Holds the wallet list and which one the terminal is pointed at. The list is
 * seeded from the server render so the first paint already has a wallet, and
 * mutated locally afterwards rather than refetched, which keeps the picker
 * from flickering between the click and the response.
 */
export function useWallets(initial: Wallet[]) {
  const [wallets, setWallets] = useState<Wallet[]>(initial);
  const [selectedId, setSelectedId] = useState<string>(initial[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  // Deferred to an effect because localStorage does not exist during the
  // server render, and reading it inline would mismatch on hydration.
  useEffect(() => {
    const stored = readStoredId();
    if (stored && wallets.some((w) => w.id === stored)) setSelectedId(stored);
    // Intentionally on mount only: later changes are driven by select().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    storeId(id);
  }, []);

  const selected = useMemo(
    () => wallets.find((w) => w.id === selectedId) ?? wallets[0] ?? null,
    [wallets, selectedId],
  );

  /** Creates a wallet and moves the terminal to it, which is why anyone clicks. */
  const create = useCallback(async () => {
    setBusy(true);

    try {
      const res = await axios.post<{ wallet: Wallet }>("/api/wallets");
      const wallet = res.data.wallet;

      setWallets((current) => [...current, wallet]);
      select(wallet.id);

      return { wallet };
    } catch (err) {
      return {
        error:
          axios.isAxiosError(err) && err.response?.data?.message
            ? (err.response.data.message as string)
            : "Could not create a wallet.",
      };
    } finally {
      setBusy(false);
    }
  }, [select]);

  const rename = useCallback(async (id: string, label: string) => {
    const previous = wallets;

    // Optimistic: the label is cosmetic, so showing it immediately and
    // rolling back on failure beats making the user wait on a round trip.
    setWallets((current) =>
      current.map((w) => (w.id === id ? { ...w, label } : w)),
    );

    try {
      await axios.patch(`/api/wallets/${id}`, { label });
      return {};
    } catch (err) {
      setWallets(previous);

      return {
        error:
          axios.isAxiosError(err) && err.response?.data?.message
            ? (err.response.data.message as string)
            : "Could not rename the wallet.",
      };
    }
  }, [wallets]);

  return { wallets, selected, select, create, rename, busy };
}
