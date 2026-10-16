"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import axios from "axios";
import {
  SUPPORTED_TOKENS,
  tokenLabel,
  SupportedToken,
  DEFAULT_SLIPPAGE_BPS,
} from "../lib/constants";
import { useJupiterQuote } from "../hooks/useJupiterQuote";
import TxReceipt from "./TxReceipt";
import AdvicePanel from "./AdvicePanel";

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
  fillMode?: "exact" | "simulated" | null;
  simulatedShortfallBps?: number | null;
  fillBucketLevel?: string | null;
  fillBucketKey?: string | null;
  fillHorizonSeconds?: number | null;
};

/** How a simulated payout was decided, in words. Never called slippage. */
function fillNote(r: Receipt): string {
  const bps = r.simulatedShortfallBps ?? 0;
  const direction = bps > 0 ? "below" : bps < 0 ? "above" : "at";
  return (
    `${Math.abs(bps).toFixed(2)} bps ${direction} the quote, drawn from recorded ` +
    `+${r.fillHorizonSeconds}s mainnet quote drift (${r.fillBucketKey ?? r.fillBucketLevel})`
  );
}

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
  ledgerSlot = null,
}: {
  walletId: string;
  balanceOf: (token: SupportedToken) => number;
  onBalancesChanged: () => Promise<void> | void;
  /** Where to render the settlement log; inline when not given. */
  ledgerSlot?: HTMLElement | null;
}) {
  const [baseAsset, setBaseAsset] = useState<SupportedToken>(
    SUPPORTED_TOKENS[2],
  );
  const [quoteAsset, setQuoteAsset] = useState<SupportedToken>(
    SUPPORTED_TOKENS[0],
  );
  const [baseAmount, setBaseAmount] = useState<string>("");

  const { quote, current, loading, error } = useJupiterQuote({
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
    if (!quote) return;

    setBusy(true);
    setNotice(null);

    try {
      // Only what the user chose. The server quotes for itself and settles
      // against that; the quote on screen is never sent back.
      const res = await axios.post("/api/swap", {
        walletId,
        inputMint: baseAsset.mint,
        outputMint: quoteAsset.mint,
        inAmountBaseUnits: quote.inAmountBaseUnits,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      });

      if (res.status === 202) {
        // Broadcast, but confirmation did not come back in time.
        setReceipt(null);
        setNotice(res.data.message ?? "Submitted; confirmation is still pending.");
      } else {
        setReceipt(res.data);
      }

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
      <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">
        USDC, USDT, JUP, BONK and WIF here are devnet stand-ins this project
        mints, priced from real mainnet quotes. No real tokens move. The vault
        holds little devnet SOL, so make large trades token to token.
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

        {quote && (
          <AdvicePanel
            baseAsset={baseAsset}
            quoteAsset={quoteAsset}
            inAmountBaseUnits={quote.inAmountBaseUnits}
            quotedImpactBps={quote.priceImpactPct === null ? null : quote.priceImpactPct * 10_000}
          />
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
          disabled={!current || busy || insufficient}
          className="mt-6 w-full rounded-[6px] bg-emerald py-3 text-sm font-medium text-paper hover:bg-emerald-deep disabled:cursor-not-allowed disabled:bg-rule disabled:text-ink-faint"
        >
          {busy ? "Settling on devnet" : "Swap"}
        </button>
      </div>

      {receipt && (
        <TxReceipt
          title="Settled"
          badge={receipt.fillMode === "simulated" ? "simulated fill" : undefined}
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
            ...(receipt.fillMode === "simulated"
              ? [{ term: "Simulated fill", value: fillNote(receipt) }]
              : []),
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

      {ledgerSlot ? createPortal(<Ledger rows={ledger} />, ledgerSlot) : <Ledger rows={ledger} />}
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
              {tokenLabel(t)}
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
        <table className="w-full whitespace-nowrap text-left text-sm">
          <thead>
            <tr className="border-b border-rule text-xs text-ink-faint">
              <th className="px-3 py-3 font-normal">Time</th>
              <th className="px-3 py-3 font-normal">Pair</th>
              <th className="px-3 py-3 font-normal">Status</th>
              <th className="px-3 py-3 text-right font-normal">Paid</th>
              <th className="px-3 py-3 text-right font-normal">Quoted</th>
              <th className="px-3 py-3 text-right font-normal">Delivered</th>
              <th className="px-3 py-3 text-right font-normal">Impact</th>
              <th className="px-3 py-3 text-right font-normal">Cap</th>
              <th className="px-3 py-3 font-normal">Signature</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-rule last:border-0">
                <td className="figure px-3 py-3.5 text-xs text-ink-soft">
                  {new Date(row.createdAt).toLocaleTimeString()}
                </td>
                <td className="px-3 py-3.5 text-ink">
                  {row.inputSymbol}/{row.outputSymbol}
                </td>
                <td
                  title={row.failureReason ?? undefined}
                  className={`px-3 py-3.5 text-xs ${row.status === "Failed" ? "text-flag" : row.status === "Pending" ? "text-ink-soft" : "text-ink"}`}
                >
                  {row.status.toLowerCase()}
                </td>
                <td className="figure px-3 py-3.5 text-right text-ink">
                  {row.inAmount}
                </td>
                <td className="figure px-3 py-3.5 text-right text-ink-soft">
                  {row.quotedOut}
                </td>
                <td className="figure px-3 py-3.5 text-right text-ink">
                  {row.settledOut ?? "—"}
                  {row.fillMode === "simulated" && (
                    <span
                      title={fillNote(row)}
                      className="ml-2 rounded-[4px] border border-rule px-1.5 py-0.5 text-[10px] text-ink-faint"
                    >
                      sim
                    </span>
                  )}
                </td>
                <td className="figure px-3 py-3.5 text-right text-xs text-ink-soft">
                  {row.priceImpactPct === null ? "—" : `${(row.priceImpactPct * 100).toFixed(2)}%`}
                </td>
                <td className="figure px-3 py-3.5 text-right text-xs text-ink-soft">
                  {row.slippageBps} bps
                </td>
                <td className="px-3 py-3.5">
                  {row.explorerUrl ? (
                    <a
                      href={row.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="figure text-xs text-emerald underline decoration-emerald/30 underline-offset-4"
                    >
                      {row.signature?.slice(0, 8)}…
                    </a>
                  ) : (
                    <span className="text-xs text-ink-faint">none</span>
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
