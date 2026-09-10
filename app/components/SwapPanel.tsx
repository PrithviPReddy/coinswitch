"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import {
  SUPPORTED_TOKENS,
  SupportedToken,
  DEFAULT_SLIPPAGE_BPS,
} from "../lib/constants";
import { useJupiterQuote } from "../hooks/useJupiterQuote";
import TxReceipt from "./TxReceipt";

type Receipt = {
  id: string;
  signature: string;
  explorerUrl: string;
  inAmount: number;
  quotedOut: number;
  settledOut: number | null;
  inputSymbol: string;
  outputSymbol: string;
  routeLabels: string[];
};

type LedgerRow = Receipt & {
  status: "Pending" | "Settled" | "Failed";
  createdAt: string;
  priceImpactPct: number | null;
  slippageBps: number;
  failureReason: string | null;
};

export default function SwapPanel({
  walletId,
  balanceOf,
  onBalancesChanged,
}: {
  walletId: string;
  balanceOf: (token: SupportedToken) => number;
  onBalancesChanged: () => Promise<void> | void;
}) {
  const [baseAsset, setBaseAsset] = useState<SupportedToken>(
    SUPPORTED_TOKENS[2],
  );
  const [quoteAsset, setQuoteAsset] = useState<SupportedToken>(
    SUPPORTED_TOKENS[0],
  );
  const [baseAmount, setBaseAmount] = useState<string>("");

  const { quote, loading, error } = useJupiterQuote({
    baseAsset,
    quoteAsset,
    baseAmount,
  });

  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadLedger = useCallback(async () => {
    if (!walletId) return;

    const res = await axios.get("/api/swaps", { params: { walletId } });
    setLedger(res.data.swaps ?? []);
  }, [walletId]);

  useEffect(() => {
    loadLedger();
  }, [loadLedger]);

  async function executeSwap() {
    if (!quote?.raw) return;

    setBusy(true);
    setNotice(null);

    try {
      const res = await axios.post("/api/swap", {
        quoteResponse: quote.raw,
        walletId,
      });
      setReceipt(res.data);
      setBaseAmount("");
      await Promise.all([onBalancesChanged(), loadLedger()]);
    } catch (err) {
      setNotice(
        axios.isAxiosError(err) && err.response?.data?.message
          ? err.response.data.message
          : "The swap did not settle.",
      );
      await loadLedger();
    } finally {
      setBusy(false);
    }
  }

  const insufficient =
    Number(baseAmount) > 0 && Number(baseAmount) > balanceOf(baseAsset);

  return (
    <>
      <p className="mt-2 text-sm text-ink-soft">
        Quoted on mainnet through Jupiter. Settled on devnet against the
        project vault.
      </p>

      <div className="panel mt-6 p-6">
        <AmountRow
          label="You pay"
          token={baseAsset}
          onTokenChange={setBaseAsset}
          exclude={quoteAsset}
          amount={baseAmount}
          onAmountChange={setBaseAmount}
          balance={balanceOf(baseAsset)}
          editable
        />

        <div className="my-5 flex items-center gap-4">
          <span className="h-px flex-1 bg-rule" />
          <button
            onClick={() => {
              setBaseAsset(quoteAsset);
              setQuoteAsset(baseAsset);
              setBaseAmount("");
            }}
            className="rounded-[6px] border border-rule px-3 py-1 text-xs text-ink-soft hover:border-emerald hover:text-emerald"
          >
            Reverse
          </button>
          <span className="h-px flex-1 bg-rule" />
        </div>

        <AmountRow
          label="You receive"
          token={quoteAsset}
          onTokenChange={setQuoteAsset}
          exclude={baseAsset}
          amount={
            loading
              ? "quoting"
              : quote
                ? quote.outAmount.toFixed(quoteAsset.decimals === 9 ? 6 : 4)
                : ""
          }
          balance={balanceOf(quoteAsset)}
        />

        {quote && (
          <dl className="rule-top mt-6 space-y-2.5 pt-5 text-sm">
            <Line
              term="Route"
              value={
                quote.routeLabels.length
                  ? quote.routeLabels.join(" → ")
                  : "direct"
              }
            />
            <Line
              term="Price impact"
              value={
                quote.priceImpactPct === null
                  ? "—"
                  : `${(quote.priceImpactPct * 100).toFixed(4)}%`
              }
            />
            <Line term="Slippage cap" value={`${DEFAULT_SLIPPAGE_BPS} bps`} />
          </dl>
        )}

        {error && <p className="mt-5 text-sm text-flag">{error}</p>}
        {insufficient && (
          <p className="mt-5 text-sm text-flag">
            Balance is short. Fund the wallet from the vault first.
          </p>
        )}
        {notice && <p className="mt-5 text-sm text-ink-soft">{notice}</p>}

        <button
          onClick={executeSwap}
          disabled={!quote || busy || insufficient}
          className="mt-6 w-full rounded-[6px] bg-emerald py-3 text-sm font-medium text-paper hover:bg-emerald-deep disabled:cursor-not-allowed disabled:bg-rule disabled:text-ink-faint"
        >
          {busy ? "Settling on devnet" : "Swap"}
        </button>
      </div>

      {receipt && (
        <TxReceipt
          title="Settled"
          signature={receipt.signature}
          explorerUrl={receipt.explorerUrl}
          rows={[
            {
              term: "Paid",
              value: `${receipt.inAmount} ${receipt.inputSymbol}`,
            },
            {
              term: "Quoted",
              value: `${receipt.quotedOut} ${receipt.outputSymbol}`,
            },
            {
              term: "Delivered",
              value:
                receipt.settledOut === null
                  ? "—"
                  : `${receipt.settledOut} ${receipt.outputSymbol}`,
              accent: true,
            },
            ...(receipt.settledOut === null
              ? []
              : [
                  {
                    term: "Difference",
                    value: `${receipt.settledOut - receipt.quotedOut >= 0 ? "+" : ""}${(
                      receipt.settledOut - receipt.quotedOut
                    ).toFixed(6)} ${receipt.outputSymbol}`,
                  },
                ]),
          ]}
        />
      )}

      <Ledger rows={ledger} />
    </>
  );
}

function Line({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt className="text-ink-soft">{term}</dt>
      <dd className="figure text-right text-ink">{value}</dd>
    </div>
  );
}

function AmountRow({
  label,
  token,
  onTokenChange,
  exclude,
  amount,
  onAmountChange,
  balance,
  editable = false,
}: {
  label: string;
  token: SupportedToken;
  onTokenChange: (t: SupportedToken) => void;
  exclude: SupportedToken;
  amount: string;
  onAmountChange?: (v: string) => void;
  balance: number;
  editable?: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-ink-soft">{label}</span>
        <span className="figure text-xs text-ink-faint">
          balance {balance.toFixed(4)}
        </span>
      </div>

      <div className="mt-2.5 flex items-center gap-3">
        <select
          value={token.mint}
          onChange={(e) =>
            onTokenChange(
              SUPPORTED_TOKENS.find((t) => t.mint === e.target.value)!,
            )
          }
          className="rounded-[6px] border border-rule bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-emerald"
        >
          {SUPPORTED_TOKENS.filter((t) => t.mint !== exclude.mint).map((t) => (
            <option key={t.mint} value={t.mint}>
              {t.name}
            </option>
          ))}
        </select>

        <input
          type={editable ? "number" : "text"}
          inputMode="decimal"
          readOnly={!editable}
          placeholder="0.00"
          value={amount}
          onChange={(e) => onAmountChange?.(e.target.value)}
          className={`figure w-full rounded-[6px] border border-rule px-3 py-2.5 text-right text-lg outline-none focus:border-emerald ${
            editable ? "text-ink" : "bg-mist text-ink-soft"
          }`}
        />
      </div>
    </div>
  );
}

function Ledger({ rows }: { rows: LedgerRow[] }) {
  if (!rows.length) {
    return (
      <section className="mt-14">
        <h2 className="text-xl text-ink">Settlement log</h2>
        <p className="mt-3 text-sm text-ink-soft">
          Swaps appear here with their quoted and delivered amounts once the
          first one settles.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-14">
      <h2 className="text-xl text-ink">Settlement log</h2>

      <div className="panel mt-5 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-rule text-xs text-ink-faint">
              <th className="px-5 py-3 font-normal">Time</th>
              <th className="px-5 py-3 font-normal">Pair</th>
              <th className="px-5 py-3 text-right font-normal">Paid</th>
              <th className="px-5 py-3 text-right font-normal">Quoted</th>
              <th className="px-5 py-3 text-right font-normal">Delivered</th>
              <th className="px-5 py-3 font-normal">Signature</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-rule last:border-0">
                <td className="figure px-5 py-3.5 text-xs text-ink-soft">
                  {new Date(row.createdAt).toLocaleTimeString()}
                </td>
                <td className="px-5 py-3.5 text-ink">
                  {row.inputSymbol}/{row.outputSymbol}
                </td>
                <td className="figure px-5 py-3.5 text-right text-ink">
                  {row.inAmount}
                </td>
                <td className="figure px-5 py-3.5 text-right text-ink-soft">
                  {row.quotedOut}
                </td>
                <td className="figure px-5 py-3.5 text-right text-ink">
                  {row.settledOut ?? "—"}
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
