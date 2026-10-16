/**
 * Builds models/fill-model.json, the empirical drift distribution the app
 * draws simulated fills from, out of the sampler's recorded QuoteDrift rows.
 *
 *   npm run build:fill-model
 *
 * Reads the database only. All of the logic (horizon assignment, volatility,
 * buckets, quantiles) lives in app/lib/fillModel.ts, which the app also uses
 * at swap time, so the artifact and the app compute features identically.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  MIN_OBSERVATIONS,
  buildFillArtifact,
  type DriftObservation,
  type PricePoint,
} from "../app/lib/fillModel";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

// The generated client is CommonJS; load it as such rather than through the
// TypeScript transform.
const { PrismaClient } = createRequire(import.meta.url)("../app/generated/prisma/index.js");

const OUT = path.resolve(process.env.FILL_MODEL_PATH || "models/fill-model.json");

type DriftRow = {
  originId: string;
  pair: string;
  notionalUsd: string | null;
  originAt: Date;
  actualElapsedMs: number | null;
  driftBps: string;
};

type PriceRow = { pair: string; sampledAt: Date; effectivePrice: string };

async function main() {
  const db = new PrismaClient();

  try {
    const driftRows: DriftRow[] = await db.$queryRaw`
      SELECT d."originSampleId" AS "originId", s.pair, s."notionalUsd"::text AS "notionalUsd",
             s."sampledAt" AS "originAt", d."actualElapsedMs", d."driftBps"::text AS "driftBps"
        FROM "QuoteDrift" d
        JOIN "QuoteSample" s ON s.id = d."originSampleId"`;

    const priceRows: PriceRow[] = await db.$queryRaw`
      SELECT pair, "sampledAt", "effectivePrice"::text AS "effectivePrice"
        FROM "QuoteSample"
       WHERE "ladderRung" = 1
       ORDER BY pair, "sampledAt"`;

    const drifts: DriftObservation[] = driftRows
      .filter((r) => r.notionalUsd !== null && r.actualElapsedMs !== null)
      .map((r) => ({
        originId: r.originId,
        pair: r.pair,
        notionalUsd: Number(r.notionalUsd),
        originAtMs: r.originAt.getTime(),
        actualElapsedMs: r.actualElapsedMs as number,
        driftBps: Number(r.driftBps),
      }));

    const priceSeries: Record<string, PricePoint[]> = {};
    for (const r of priceRows) {
      (priceSeries[r.pair] ??= []).push({ t: r.sampledAt.getTime(), price: Number(r.effectivePrice) });
    }

    const builtAt = new Date().toISOString();
    const draft = buildFillArtifact({ drifts, priceSeries, builtAt, version: "pending" });

    // The version names when it was built and what it contains, so a swap
    // row's fillModelVersion pins down exactly which distribution it drew from.
    const digest = crypto
      .createHash("sha256")
      .update(JSON.stringify({ buckets: draft.buckets, tertiles: draft.volatility.tertiles }))
      .digest("hex")
      .slice(0, 8);
    const stamp = builtAt.replace(/[-:]/g, "").slice(0, 13);
    const artifact = { ...draft, version: `fill-q-${stamp}Z-${digest}` };

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(artifact, null, 1) + "\n");

    console.log(`wrote ${path.relative(process.cwd(), OUT)}  version ${artifact.version}`);
    console.log(
      `drift rows: ${artifact.dataset.driftRows} total, ${artifact.dataset.driftRowsUsed} used, ` +
        `${artifact.dataset.driftRowsOffHorizon} left out (not within tolerance of any horizon)`,
    );
    console.log(`data from ${artifact.dataset.from} to ${artifact.dataset.to}`);
    console.log(`buckets need >= ${MIN_OBSERVATIONS} observations; sparser ones fall back up the hierarchy`);

    for (const [h, forH] of Object.entries(artifact.buckets)) {
      const byLevel: Record<string, number> = {};
      for (const b of Object.values(forH)) byLevel[b.level] = (byLevel[b.level] ?? 0) + 1;
      console.log(`  +${h}s: ${Object.entries(byLevel).map(([l, c]) => `${c} ${l}`).join(", ")}`);
    }

    const noTertiles = Object.entries(artifact.volatility.tertiles)
      .filter(([, t]) => t === null)
      .map(([p]) => p);
    if (noTertiles.length) {
      console.log(`no volatility split yet (fewer than ${3 * MIN_OBSERVATIONS} origins): ${noTertiles.join(", ")}`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
