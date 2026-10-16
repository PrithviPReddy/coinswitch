/**
 * Server-side inputs for a fill decision: which mode, which artifact, and the
 * live features the artifact is keyed on. The decision itself is the pure
 * simulatedFill in fill.ts.
 *
 * Features are computed with the same functions the artifact was built with
 * (fillModel.ts), from the same tables the sampler writes, so what the app
 * looks up at swap time means exactly what it meant at build time.
 */

import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import db from "@/app/db";
import type { TokenDetails } from "./constants";
import { simulatedFill, type FillAudit, type FillDecision, type FillMode } from "./fill";
import {
  VOLATILITY,
  realisedVolatility,
  validateFillArtifact,
  type FillArtifact,
} from "./fillModel";
import type { Quote } from "./jupiter";

const ARTIFACT_PATH = path.resolve(process.env.FILL_MODEL_PATH || "models/fill-model.json");

/** Older than this and the startup log says so, loudly. */
const STALE_AFTER_HOURS = 12;

/** FILL_MODE=exact | simulated, simulated unless set otherwise. */
export function configuredFillMode(): FillMode {
  const raw = (process.env.FILL_MODE || "simulated").trim().toLowerCase();
  if (raw === "exact" || raw === "simulated") return raw;
  console.error(`[fill] FILL_MODE="${raw}" is not exact or simulated. Using EXACT fills.`);
  return "exact";
}

let cached: { artifact: FillArtifact | null; reason: string | null } | null = null;

/**
 * The fill artifact, read and validated once per process. Any problem is
 * logged loudly and turns simulated fills off rather than drawing from a
 * distribution nobody can vouch for.
 */
export function loadFillArtifact(): { artifact: FillArtifact | null; reason: string | null } {
  if (cached) return cached;

  let reason: string | null = null;
  let artifact: FillArtifact | null = null;

  if (!fs.existsSync(ARTIFACT_PATH)) {
    reason = `no fill model at ${ARTIFACT_PATH}; run \`npm run build:fill-model\``;
  } else {
    try {
      const result = validateFillArtifact(JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8")));
      if (result.ok) artifact = result.artifact;
      else reason = `fill model at ${ARTIFACT_PATH} is invalid: ${result.errors.slice(0, 3).join("; ")}`;
    } catch (error) {
      reason = `fill model at ${ARTIFACT_PATH} could not be read: ${String(error)}`;
    }
  }

  if (reason) {
    console.error(`[fill] ${"!".repeat(8)} SIMULATED FILLS ARE OFF: ${reason}. Every swap will settle at exactly the quote.`);
  } else {
    const ageHours = (Date.now() - Date.parse(artifact!.builtAt)) / 3_600_000;
    console.log(
      `[fill] simulated fills on, model ${artifact!.version}, built ${ageHours.toFixed(1)} h ago ` +
        `from drift up to ${artifact!.dataset.to}`,
    );
    if (!(ageHours <= STALE_AFTER_HOURS)) {
      console.warn(
        `[fill] ${"!".repeat(8)} THE FILL MODEL IS ${ageHours.toFixed(1)} HOURS OLD (over ${STALE_AFTER_HOURS} h). ` +
          "Fills draw from stale drift. Rebuild with `npm run build:fill-model` before a demo.",
      );
    }
  }

  cached = { artifact, reason };
  return cached;
}

/** The sampled pair whose market a swap trades in, if any. */
function sourcePair(artifact: FillArtifact, input: string, output: string): string | null {
  if (artifact.pairs[`${input}/${output}`]) return `${input}/${output}`;
  if (artifact.pairs[`${output}/${input}`]) return `${output}/${input}`;
  return null;
}

/** Realised volatility for a sampled pair right now, from the sampler's rows. */
async function currentVolatility(pair: string): Promise<number | null> {
  const since = new Date(Date.now() - VOLATILITY.windowMinutes * 60_000);
  const rows = await db.quoteSample.findMany({
    where: { pair, ladderRung: VOLATILITY.rung, sampledAt: { gte: since } },
    orderBy: { sampledAt: "asc" },
    select: { sampledAt: true, effectivePrice: true },
  });
  return realisedVolatility(
    rows.map((r) => ({ t: r.sampledAt.getTime(), price: Number(r.effectivePrice) })),
    Date.now(),
  );
}

/**
 * How long this swap will take from quote to confirmation: the median
 * measured quote-to-confirmation time of recent settled swaps, and never
 * less than the time this one has already spent. With no history yet, only
 * the elapsed time counts, which errs towards the shortest horizon.
 *
 * (A sum of time-since-quote and median sign-to-confirm undercounted: it
 * missed the balance and vault checks between quote and signing. Measured
 * on 2026-10-16 it predicted ~2.8 s against a real 3.4-5.8 s.)
 */
async function latencyEstimateMs(quotedAt: Date): Promise<number> {
  const recent = await db.swap.findMany({
    where: { status: "Settled", quotedAt: { not: null }, confirmedAt: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { quotedAt: true, confirmedAt: true },
  });

  const totals = recent
    .map((r) => r.confirmedAt!.getTime() - r.quotedAt!.getTime())
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);
  const median = totals.length ? totals[Math.floor(totals.length / 2)] : 0;

  return Math.max(Date.now() - quotedAt.getTime(), median);
}

/** A uniform draw in [0, 1) from the OS generator (randomInt caps the range below 2^48). */
function uniform(): number {
  return randomInt(0, 2 ** 47) / 2 ** 47;
}

export type FillContext = {
  quote: Quote;
  slippageBps: number;
  inputToken: TokenDetails;
  outputToken: TokenDetails;
  /** The input token's mainnet USD price, or 0 when unavailable. */
  inputUsdPrice: number;
};

export async function decideFillForSwap(
  ctx: FillContext,
): Promise<{ decision: FillDecision; audit: FillAudit }> {
  const mode = configuredFillMode();
  const { artifact, reason } = loadFillArtifact();

  const notionalUsd =
    ctx.inputUsdPrice > 0
      ? (Number(ctx.quote.inAmount) / 10 ** ctx.inputToken.decimals) * ctx.inputUsdPrice
      : null;
  const latency = await latencyEstimateMs(ctx.quote.quotedAt);

  if (mode === "exact" || !artifact) {
    const result = simulatedFill({
      artifact: null,
      quotedOut: ctx.quote.outAmount,
      slippageBps: ctx.slippageBps,
      inputSymbol: ctx.inputToken.name,
      outputSymbol: ctx.outputToken.name,
      notionalUsd,
      volatility: null,
      latencyEstimateMs: latency,
      u: 0,
    });
    const why = mode === "exact" ? "FILL_MODE=exact" : reason ?? "no artifact";
    if (mode !== "exact") console.warn(`[fill] exact fill for this swap: ${why}`);
    return { ...result, audit: { ...result.audit, fallbackReason: why } };
  }

  const source = sourcePair(artifact, ctx.inputToken.name, ctx.outputToken.name);
  const volatility = source ? await currentVolatility(source) : null;

  const result = simulatedFill({
    artifact,
    quotedOut: ctx.quote.outAmount,
    slippageBps: ctx.slippageBps,
    inputSymbol: ctx.inputToken.name,
    outputSymbol: ctx.outputToken.name,
    notionalUsd,
    volatility,
    latencyEstimateMs: latency,
    u: uniform(),
  });

  if (result.audit.fallbackReason) {
    console.warn(`[fill] exact fill for this swap: ${result.audit.fallbackReason}`);
  }
  return result;
}
