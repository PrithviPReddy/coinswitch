/**
 * Brings rows recorded by sampler v1 up to the v2 columns, using only values
 * already stored on those rows. Nothing is fetched and nothing is invented.
 *
 *   QuoteSample, rows with notionalSource IS NULL (v1 rows only):
 *     measuredImpactBps    re-measured against rung 1 of the same ladder,
 *                          the v2 baseline, instead of rung 0; null when the
 *                          ladder has no rung 1
 *     baselineRouteLabels  rung 1's routeLabels
 *     notionalUsd          stablecoin input: the amount at $1 ("backfill_par")
 *                          SOL input: the amount at the ladder's own rung-1
 *                          SOL/stable price, falling back to the row's own
 *                          price if rung 1 is missing ("backfill_ladder")
 *
 *   QuoteDrift, rows with actualElapsedMs IS NULL:
 *     actualElapsedMs      requotedAt minus the origin's sampledAt
 *
 * Every v1 pair had a SOL, USDC or USDT input and, where the input was SOL, a
 * stablecoin output, which is what makes those two valuations available. The
 * script refuses to run if that stops being true.
 *
 * Idempotent: v2 rows always carry notionalSource and actualElapsedMs, so a
 * second run finds nothing to do.
 *
 *   node scripts/sampler/backfill-v2.mjs
 */

import fs from "node:fs";
import { PrismaClient } from "../../app/generated/prisma/index.js";
import { TOKENS } from "./core.mjs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const SOL = TOKENS.SOL.mint;
const STABLES = [TOKENS.USDC.mint, TOKENS.USDT.mint];

const db = new PrismaClient();

async function main() {
  const unexpected = await db.$queryRawUnsafe(
    `SELECT DISTINCT pair FROM "QuoteSample"
      WHERE "notionalSource" IS NULL
        AND NOT ("inputMint" = ANY($1::text[])
                 OR ("inputMint" = $2 AND "outputMint" = ANY($3::text[])))`,
    STABLES,
    SOL,
    STABLES,
  );

  if (unexpected.length) {
    throw new Error(
      `Unvalued pairs need a backfill rule: ${unexpected.map((r) => r.pair).join(", ")}`,
    );
  }

  const samples = await db.$executeRawUnsafe(
    `WITH baseline AS (
        SELECT "ladderId", "effectivePrice" AS p1, "routeLabels" AS r1
          FROM "QuoteSample"
         WHERE "ladderRung" = 1 AND "notionalSource" IS NULL
     ),
     target AS (
        SELECT s.id, b.p1, b.r1
          FROM "QuoteSample" s
          LEFT JOIN baseline b USING ("ladderId")
         WHERE s."notionalSource" IS NULL
     )
     UPDATE "QuoteSample" s
        SET "measuredImpactBps" =
              CASE WHEN t.p1 IS NULL THEN NULL
                   ELSE round((t.p1 - s."effectivePrice") / t.p1 * 10000, 6) END,
            "baselineRouteLabels" = COALESCE(t.r1, ARRAY[]::text[]),
            "notionalUsd" =
              CASE WHEN s."inputMint" = $1
                   THEN round(s."inAmountBaseUnits"::numeric / 1e9 * COALESCE(t.p1, s."effectivePrice"), 6)
                   ELSE round(s."inAmountBaseUnits"::numeric / 1e6, 6) END,
            "notionalSource" =
              CASE WHEN s."inputMint" = $1 THEN 'backfill_ladder' ELSE 'backfill_par' END
       FROM target t
      WHERE s.id = t.id`,
    SOL,
  );

  const drift = await db.$executeRawUnsafe(
    `UPDATE "QuoteDrift" d
        SET "actualElapsedMs" = round(extract(epoch FROM d."requotedAt" - s."sampledAt") * 1000)::int
       FROM "QuoteSample" s
      WHERE s.id = d."originSampleId" AND d."actualElapsedMs" IS NULL`,
  );

  console.log(JSON.stringify({ quoteSampleRowsBackfilled: samples, quoteDriftRowsBackfilled: drift }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
