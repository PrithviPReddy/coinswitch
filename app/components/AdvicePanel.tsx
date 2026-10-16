"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { DEFAULT_SLIPPAGE_BPS, SupportedToken } from "../lib/constants";

type Plan = {
  mode: "SEND_NOW" | "SPLIT" | "TIGHTEN_AND_RETRY";
  params: { k?: number; windowSeconds?: number; capBps?: number; retries?: number };
  totalBps: number;
  structuralBps: number;
  transientBps: number;
  impactBps: number;
  driftBps: number;
  failureProbability: number;
  feeBps: number;
  coverage: string;
  lowConfidence: boolean;
};

type Advice = {
  pair: string;
  notionalUsd: number;
  mode: "SEND_NOW" | "SPLIT" | "TIGHTEN_AND_RETRY" | "DEFER";
  best: Plan;
  alternatives: Plan[];
  structuralShare: number;
  explanation: string;
  splitAtGridBoundary: boolean;
  lowConfidence: boolean;
  recoveryAssumed: number;
  model: { version: string; producer: string; exampleOnly: boolean };
};

const bps = (x: number) => (x < 0.01 ? "<0.01" : x < 10 ? x.toFixed(2) : x.toFixed(0));
const usd = (bpsValue: number, notional: number) => {
  const v = (bpsValue * notional) / 10_000;
  return v < 0.01 ? "<$0.01" : `$${v.toLocaleString("en-US", { maximumFractionDigits: v < 100 ? 2 : 0 })}`;
};
const duration = (s: number) => (s >= 60 ? `${s / 60} min` : `${s} s`);

/** Why a prediction is low confidence, in words, from its coverage flag. */
const COVERAGE_NOTE: Record<string, string> = {
  sparse: "Part of this prediction rests on fewer than 30 recorded observations.",
  fallback: "Part of this prediction is borrowed from pooled data for similar pairs, the reverse direction, or a default volatility.",
  extrapolated:
    "Part of this prediction lies outside what was measured: waits between portions longer than the 60 s the sampler records, or sizes outside the sampled range.",
  none: "There is no recorded data behind part of this prediction.",
};

function describe(p: Plan): { title: string; detail: string } {
  if (p.mode === "SPLIT") return { title: "Split", detail: `${p.params.k} portions over ${duration(p.params.windowSeconds!)}` };
  if (p.mode === "TIGHTEN_AND_RETRY") return { title: "Tighten and retry", detail: `cap ${p.params.capBps} bps, up to ${p.params.retries} tries` };
  return { title: "Send now", detail: "one order" };
}

/**
 * What the execution advisor would do with this order, and what each
 * alternative was predicted to cost. Advisory only: the swap button still
 * sends one order.
 */
export default function AdvicePanel({
  baseAsset,
  quoteAsset,
  inAmountBaseUnits,
  quotedImpactBps = null,
}: {
  baseAsset: SupportedToken;
  quoteAsset: SupportedToken;
  inAmountBaseUnits: string;
  /** Jupiter's price impact for this exact order, from the live quote. */
  quotedImpactBps?: number | null;
}) {
  // Results are stored with the request they answer, and only shown while
  // that request still matches what is on screen.
  const key = `${baseAsset.mint}>${quoteAsset.mint}:${inAmountBaseUnits}`;
  const [result, setResult] = useState<{ key: string; advice: Advice | null; error: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    axios
      .get("/api/advice", {
        params: { inputMint: baseAsset.mint, outputMint: quoteAsset.mint, amount: inAmountBaseUnits, slippageBps: DEFAULT_SLIPPAGE_BPS },
      })
      .then((res) => live && setResult({ key, advice: res.data, error: null }))
      .catch((err) =>
        live &&
        setResult({
          key,
          advice: null,
          error: axios.isAxiosError(err) && err.response?.data?.error ? err.response.data.error : "Advice unavailable",
        }),
      );
    return () => {
      live = false;
    };
  }, [key, baseAsset.mint, quoteAsset.mint, inAmountBaseUnits]);

  const current = result?.key === key ? result : null;
  const advice = current?.advice ?? null;
  const error = current?.error ?? null;

  if (error) return <p className="mt-5 text-xs text-ink-faint">Execution advice: {error}</p>;
  if (!advice) return <p className="mt-5 text-xs text-ink-faint">Execution advice: pricing the alternatives…</p>;

  const chosen = describe(advice.best);
  const sameAsBest = (p: Plan) => p.mode === advice.best.mode && JSON.stringify(p.params) === JSON.stringify(advice.best.params);
  const coverageNote = (p: Plan) => `${COVERAGE_NOTE[p.coverage] ?? "Coverage: " + p.coverage + "."} Treat it as a rough guide.`;
  const sendNow = advice.alternatives.find((p) => p.mode === "SEND_NOW");
  const savedBps = sendNow ? sendNow.totalBps - advice.best.totalBps : 0;

  return (
    <section className="rule-top mt-6 pt-5 text-sm">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-ink-soft">Execution advice</h3>
        {advice.lowConfidence && (
          <span title={coverageNote(advice.best)} className="text-[11px] text-ink-faint">
            low confidence
          </span>
        )}
      </div>

      <p className="mt-2 text-ink">
        <span className="font-medium">{chosen.title}</span>
        <span className="text-ink-soft">: {chosen.detail}</span>
        <span className="figure float-right">
          {bps(advice.best.totalBps)} bps · {usd(advice.best.totalBps, advice.notionalUsd)}
        </span>
      </p>
      <p className="figure mt-1 text-xs text-ink-faint">
        impact {bps(advice.best.impactBps)} · drift {bps(advice.best.driftBps)} · fees {bps(advice.best.feeBps)} bps
        {advice.best.failureProbability > 0.001 && ` · ${(100 * advice.best.failureProbability).toFixed(1)}% chance a fill misses the cap`}
      </p>
      {sendNow && advice.best.mode !== "SEND_NOW" && savedBps > 0 && (
        <p className="mt-2 text-xs leading-relaxed text-ink-soft">
          Predicted to cost {bps(savedBps)} bps ({usd(savedBps, advice.notionalUsd)}) less than sending one order now.
          {advice.splitAtGridBoundary &&
            ` ${advice.best.params.k} portions is the most the advisor tries, so more might be cheaper still.`}
        </p>
      )}
      <p className="mt-2 text-xs leading-relaxed text-ink-soft">{advice.explanation}</p>
      {sendNow && quotedImpactBps !== null && (
        <p className="figure mt-1 text-xs text-ink-faint">
          Impact of one order: {bps(quotedImpactBps)} bps on the live quote, {bps(sendNow.impactBps)} bps predicted by the
          model. The plans are compared on the model&apos;s figures.
        </p>
      )}

      <table className="mt-3 w-full text-xs">
        <tbody>
          {advice.alternatives.map((p) => {
            const d = describe(p);
            return (
              <tr key={p.mode} className={sameAsBest(p) ? "text-ink" : "text-ink-faint"}>
                <td className="py-0.5 pr-2">{sameAsBest(p) ? "▸" : ""}</td>
                <td className="py-0.5">{d.title}</td>
                <td className="py-0.5 text-ink-faint">{d.detail}</td>
                <td className="figure py-0.5 text-right">{bps(p.totalBps)} bps</td>
                <td className="figure py-0.5 pl-3 text-right">{usd(p.totalBps, advice.notionalUsd)}</td>
                <td className="py-0.5 pl-2 text-right">
                  {p.lowConfidence && (
                    <span title={coverageNote(p)} className="text-[10px] text-ink-faint">
                      low conf.
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        Predicted costs, not quotes. This app sends one order; split execution is not implemented. The advice assumes
        pools fully recover between split portions. Recovery is unmeasured; if a pool does not recover, a split costs
        more than shown here, and the backtest in reports/backtest reports by how much. Model {advice.model.version}
        {advice.model.exampleOnly ? " (example artifact, not the trained model)" : ""}.
      </p>
    </section>
  );
}
