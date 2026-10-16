/**
 * Dumps QuoteSample and QuoteDrift to CSV, one file per table, every column
 * as stored, plus export_manifest.json. The dataset is a deliverable in its
 * own right, so this is a faithful copy: no filtering, no derived columns, no
 * rows added. Features are derived in the notebook, in one documented place.
 *
 *   npm run export:samples                  gzipped, to ./exports
 *   npm run export:samples -- --out DIR
 *   npm run export:samples -- --plain       uncompressed .csv
 *
 * Upload all three files to notebooks/train_cost_model.ipynb.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { PrismaClient } from "../app/generated/prisma/index.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const outFlag = process.argv.indexOf("--out");
const outDir = path.resolve(outFlag > -1 ? process.argv[outFlag + 1] : "exports");

const GZIP = !process.argv.includes("--plain");

const BATCH = 5_000;

const SAMPLE_COLUMNS = [
  "id",
  "sampledAt",
  "pair",
  "inputMint",
  "outputMint",
  "inAmountBaseUnits",
  "outAmountBaseUnits",
  "effectivePrice",
  "reportedImpactPct",
  "measuredImpactBps",
  "routeLabels",
  "baselineRouteLabels",
  "notionalUsd",
  "notionalSource",
  "hopCount",
  "slippageBps",
  "contextSlot",
  "apiLatencyMs",
  "ladderId",
  "ladderRung",
];

const DRIFT_COLUMNS = [
  "id",
  "originSampleId",
  "delaySeconds",
  "requotedAt",
  "outAmountBaseUnits",
  "effectivePrice",
  "driftBps",
  "actualElapsedMs",
  "apiLatencyMs",
  "contextSlot",
];

function cell(value) {
  if (value === null || value === undefined) return "";
  let text;
  if (value instanceof Date) text = value.toISOString();
  // Route labels can contain spaces and commas; "|" never appears in one.
  else if (Array.isArray(value)) text = value.join("|");
  else text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Streams a table in id-cursor batches so memory stays flat as it grows. */
async function exportTable(delegate, columns, orderField, file) {
  const out = fs.createWriteStream(file);
  const stream = GZIP ? zlib.createGzip({ level: 9 }) : out;
  if (GZIP) stream.pipe(out);
  stream.write(columns.join(",") + "\n");

  let cursor;
  let total = 0;

  for (;;) {
    const rows = await delegate.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: [{ [orderField]: "asc" }, { id: "asc" }],
    });

    if (!rows.length) break;

    for (const row of rows) {
      stream.write(columns.map((c) => cell(row[c])).join(",") + "\n");
    }

    total += rows.length;
    cursor = rows[rows.length - 1].id;
    if (rows.length < BATCH) break;
  }

  await new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    stream.end();
  });

  return total;
}

async function main() {
  const db = new PrismaClient();
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const ext = GZIP ? ".csv.gz" : ".csv";
    const samplesFile = path.join(outDir, `quote_samples${ext}`);
    const driftFile = path.join(outDir, `quote_drift${ext}`);
    const manifestFile = path.join(outDir, "export_manifest.json");

    const samples = await exportTable(db.quoteSample, SAMPLE_COLUMNS, "sampledAt", samplesFile);
    const drift = await exportTable(db.quoteDrift, DRIFT_COLUMNS, "requotedAt", driftFile);

    // What the notebook needs to know that the rows themselves do not say.
    const manifest = {
      exportedAt: new Date().toISOString(),
      rowCounts: { quoteSamples: samples, quoteDrift: drift },
      files: { quoteSamples: path.basename(samplesFile), quoteDrift: path.basename(driftFile) },
      columns: { quoteSamples: SAMPLE_COLUMNS, quoteDrift: DRIFT_COLUMNS },
      conventions: {
        pair: "INPUT/OUTPUT token symbols",
        measuredImpactBps: "vs rung 1 (~$25) of the same ladder; positive = worse price",
        driftBps: "positive = the later quote pays out less",
        routeLabels: "joined with |",
        timestamps: "ISO 8601 UTC",
      },
      collectionPhases: {
        v1Start: "2026-10-16T04:04:14Z",
        v2Start: "2026-10-16T08:29:15Z",
        limiterReserveFix: "2026-10-16T10:42:12Z",
        limiterKeylessPriceFix: "2026-10-16T10:49:57Z",
      },
      thinTokens: ["JUP", "BONK", "WIF"],
    };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");

    const size = (f) => `${(fs.statSync(f).size / 1024).toFixed(1)} KB`;
    console.log(`${String(samples).padStart(7)} rows  ${size(samplesFile).padStart(9)}  ${samplesFile}`);
    console.log(`${String(drift).padStart(7)} rows  ${size(driftFile).padStart(9)}  ${driftFile}`);
    console.log(`${"".padStart(12)}${size(manifestFile).padStart(9)}  ${manifestFile}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
