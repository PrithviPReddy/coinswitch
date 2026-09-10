"use client";

import { useState } from "react";
import axios from "axios";
import Image from "next/image";
import { SUPPORTED_TOKENS, SupportedToken } from "../lib/constants";
import { useTokens } from "../hooks/useTokens";
import { useWallets, type Wallet } from "../hooks/useWallets";
import WalletPicker from "./WalletPicker";
import SwapPanel from "./SwapPanel";
import SendPanel from "./SendPanel";

type Tab = "swap" | "send";

/**
 * The shell around both halves of the terminal. It owns the one thing they
 * share - which wallet is selected - so switching tabs never changes the
 * wallet under you, and the balances in the sidebar are the same numbers both
 * panels are working from.
 */
export default function Terminal({
  wallets: initialWallets,
  walletLimit,
}: {
  wallets: Wallet[];
  walletLimit: number;
}) {
  const {
    wallets,
    selected,
    select,
    create,
    rename,
    busy: walletBusy,
  } = useWallets(initialWallets);

  const [tab, setTab] = useState<Tab>("swap");
  const [funding, setFunding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const publicKey = selected?.publicKey ?? "";
  const walletId = selected?.id ?? "";

  const { tokenBalances, refresh } = useTokens(publicKey);

  const balanceOf = (token: SupportedToken) =>
    tokenBalances?.tokens.find((t) => t.mint === token.mint)?.balance ?? 0;

  async function fundWallet() {
    setFunding(true);
    setNotice(null);

    try {
      await axios.post("/api/fund", { walletId });
      await refresh();
      setNotice("Wallet funded from the vault.");
    } catch (err) {
      setNotice(
        axios.isAxiosError(err) && err.response?.data?.message
          ? err.response.data.message
          : "Funding failed.",
      );
    } finally {
      setFunding(false);
    }
  }

  async function createWallet() {
    const { error } = await create();
    setNotice(error ?? "New wallet created. Fund it before swapping.");
  }

  async function renameWallet(id: string, label: string) {
    const { error } = await rename(id, label);
    if (error) setNotice(error);
  }

  // The dashboard only renders this with at least one wallet, so this is a
  // type guard rather than a state the user can reach.
  if (!selected) return null;

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section>
          <div className="flex items-baseline gap-6">
            <TabButton
              label="Swap"
              active={tab === "swap"}
              onClick={() => setTab("swap")}
            />
            <TabButton
              label="Send"
              active={tab === "send"}
              onClick={() => setTab("send")}
            />
          </div>

          {tab === "swap" ? (
            <SwapPanel
              // Keyed on the wallet so a pending quote, receipt or ledger from
              // the previous wallet cannot survive a switch.
              key={walletId}
              walletId={walletId}
              balanceOf={balanceOf}
              onBalancesChanged={refresh}
            />
          ) : (
            <SendPanel
              key={walletId}
              walletId={walletId}
              senderPublicKey={publicKey}
              wallets={wallets}
              balanceOf={balanceOf}
              onBalancesChanged={refresh}
            />
          )}
        </section>

        <aside className="space-y-6">
          <WalletPicker
            // Remounts on wallet switch, which clears any in-progress rename.
            key={selected.id}
            wallets={wallets}
            selected={selected}
            limit={walletLimit}
            onSelect={select}
            onCreate={createWallet}
            onRename={renameWallet}
            onFund={fundWallet}
            creating={walletBusy}
            funding={funding}
          />

          {notice && (
            <p className="px-1 text-sm text-ink-soft">{notice}</p>
          )}

          <div className="panel p-6">
            <h2 className="text-base text-ink">Balances</h2>

            <ul className="mt-4 space-y-3.5">
              {SUPPORTED_TOKENS.map((token) => (
                <li
                  key={token.mint}
                  className="flex items-center justify-between"
                >
                  <span className="flex items-center gap-2.5">
                    <Image
                      src={token.image}
                      alt=""
                      width={22}
                      height={22}
                      className="rounded-full"
                    />
                    <span className="text-sm text-ink">{token.name}</span>
                  </span>
                  <span className="figure text-sm text-ink">
                    {balanceOf(token).toFixed(4)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`border-b-2 pb-1.5 text-2xl transition-colors ${
        active
          ? "border-emerald text-ink"
          : "border-transparent text-ink-faint hover:text-ink-soft"
      }`}
    >
      {label}
    </button>
  );
}
