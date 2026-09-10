"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { SUPPORTED_TOKENS, SupportedToken } from "../lib/constants";
import type { Wallet } from "../hooks/useWallets";
import TxReceipt from "./TxReceipt";

type Receipt = {
  id: string;
  signature: string;
  explorerUrl: string;
  amount: number;
  symbol: string;
  recipient: string;
};

type TransferRow = {
  id: string;
  recipient: string;
  symbol: string;
  amount: number;
  signature: string | null;
  explorerUrl: string | null;
  status: "Pending" | "Sent" | "Failed";
  failureReason: string | null;
  createdAt: string;
};

const shorten = (address: string) =>
  address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;

/**
 * Sends one token out of the selected wallet to any devnet address. Unlike a
 * swap there is nothing to quote: the amount that leaves is the amount that
 * arrives, so the only figure worth checking before signing is the balance.
 */
export default function SendPanel({
  walletId,
  senderPublicKey,
  wallets,
  balanceOf,
  onBalancesChanged,
}: {
  walletId: string;
  senderPublicKey: string;
  wallets: Wallet[];
  balanceOf: (token: SupportedToken) => number;
  onBalancesChanged: () => Promise<void> | void;
}) {
  const [token, setToken] = useState<SupportedToken>(SUPPORTED_TOKENS[0]);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");

  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Every wallet on the account except the one sending, since a wallet cannot
  // send to itself.
  const otherWallets = wallets.filter((w) => w.publicKey !== senderPublicKey);

  const loadTransfers = useCallback(async () => {
    if (!walletId) return;

    const res = await axios.get("/api/transfers", { params: { walletId } });
    setTransfers(res.data.transfers ?? []);
  }, [walletId]);

  useEffect(() => {
    loadTransfers();
  }, [loadTransfers]);

  const balance = balanceOf(token);
  const requested = Number(amount);
  const insufficient = requested > 0 && requested > balance;

  async function send() {
    setBusy(true);
    setNotice(null);

    try {
      const res = await axios.post("/api/send", {
        walletId,
        mint: token.mint,
        amount: requested,
        recipient: recipient.trim(),
      });

      setReceipt(res.data);
      setAmount("");
      setRecipient("");
      await Promise.all([onBalancesChanged(), loadTransfers()]);
    } catch (err) {
      setNotice(
        axios.isAxiosError(err) && err.response?.data?.message
          ? err.response.data.message
          : "The transfer did not go through.",
      );
      await loadTransfers();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="mt-2 text-sm text-ink-soft">
        Moves tokens out of the selected wallet to any devnet address. The
        vault pays the fee, so the whole balance is sendable.
      </p>

      <div className="panel mt-6 p-6">
        <span className="text-sm text-ink-soft">To</span>

        <input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="Devnet address"
          spellCheck={false}
          className="figure mt-2.5 w-full rounded-[6px] border border-rule px-3 py-2.5 text-sm text-ink outline-none focus:border-emerald"
        />

        {otherWallets.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-faint">or send to</span>
            {otherWallets.map((wallet) => (
              <button
                key={wallet.id}
                onClick={() => setRecipient(wallet.publicKey)}
                className="rounded-[6px] border border-rule px-2.5 py-1 text-xs text-ink-soft hover:border-emerald hover:text-emerald"
              >
                {wallet.label}
              </button>
            ))}
          </div>
        )}

        <div className="mt-6 flex items-baseline justify-between">
          <span className="text-sm text-ink-soft">Amount</span>
          <button
            onClick={() => setAmount(String(balance))}
            className="figure text-xs text-ink-faint hover:text-emerald"
          >
            balance {balance.toFixed(4)} — send all
          </button>
        </div>

        <div className="mt-2.5 flex items-center gap-3">
          <select
            value={token.mint}
            onChange={(e) =>
              setToken(
                SUPPORTED_TOKENS.find((t) => t.mint === e.target.value)!,
              )
            }
            className="rounded-[6px] border border-rule bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-emerald"
          >
            {SUPPORTED_TOKENS.map((t) => (
              <option key={t.mint} value={t.mint}>
                {t.name}
              </option>
            ))}
          </select>

          <input
            type="number"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="figure w-full rounded-[6px] border border-rule px-3 py-2.5 text-right text-lg text-ink outline-none focus:border-emerald"
          />
        </div>

        {insufficient && (
          <p className="mt-5 text-sm text-flag">
            That is more {token.name} than this wallet holds.
          </p>
        )}
        {notice && <p className="mt-5 text-sm text-flag">{notice}</p>}

        <button
          onClick={send}
          disabled={busy || insufficient || !recipient.trim() || requested <= 0}
          className="mt-6 w-full rounded-[6px] bg-emerald py-3 text-sm font-medium text-paper hover:bg-emerald-deep disabled:cursor-not-allowed disabled:bg-rule disabled:text-ink-faint"
        >
          {busy ? "Sending on devnet" : "Send"}
        </button>
      </div>

      {receipt && (
        <TxReceipt
          title="Sent"
          signature={receipt.signature}
          explorerUrl={receipt.explorerUrl}
          rows={[
            {
              term: "Amount",
              value: `${receipt.amount} ${receipt.symbol}`,
              accent: true,
            },
            { term: "To", value: shorten(receipt.recipient) },
          ]}
        />
      )}

      <TransferLog rows={transfers} />
    </>
  );
}

function TransferLog({ rows }: { rows: TransferRow[] }) {
  if (!rows.length) {
    return (
      <section className="mt-14">
        <h2 className="text-xl text-ink">Sent from this wallet</h2>
        <p className="mt-3 text-sm text-ink-soft">
          Transfers appear here with their explorer link once the first one
          goes out.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-14">
      <h2 className="text-xl text-ink">Sent from this wallet</h2>

      <div className="panel mt-5 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-rule text-xs text-ink-faint">
              <th className="px-5 py-3 font-normal">Time</th>
              <th className="px-5 py-3 font-normal">To</th>
              <th className="px-5 py-3 text-right font-normal">Amount</th>
              <th className="px-5 py-3 font-normal">Signature</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-rule last:border-0">
                <td className="figure px-5 py-3.5 text-xs text-ink-soft">
                  {new Date(row.createdAt).toLocaleTimeString()}
                </td>
                <td className="figure px-5 py-3.5 text-xs text-ink">
                  {shorten(row.recipient)}
                </td>
                <td className="figure px-5 py-3.5 text-right text-ink">
                  {row.amount} {row.symbol}
                </td>
                <td className="px-5 py-3.5">
                  {row.explorerUrl ? (
                    <a
                      href={row.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="figure text-xs text-emerald underline decoration-emerald/30 underline-offset-4"
                    >
                      {row.signature?.slice(0, 12)}…
                    </a>
                  ) : (
                    <span className="text-xs text-flag">
                      {row.status === "Failed" ? "failed" : "pending"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
