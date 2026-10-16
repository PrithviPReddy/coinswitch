/**
 * Dumps QuoteSample and QuoteDrift to CSV, one file per table, every column
 * as stored. The dataset is a deliverable in its own right, so this is a
 * faithful copy: no filtering, no derived columns, no rows added.
 *
 *   node scripts/export-samples.mjs              writes to ./exports
 *   node scripts/export-samples.mjs --out DIR
 */

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "../app/generated/prisma/index.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const outFlag = process.argv.indexOf("--out");
const outDir = path.resolve(outFlag > -1 ? process.argv[outFlag + 1] : "exports");

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
  const stream = fs.createWriteStream(file);
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
    stream.end(resolve);
    stream.on("error", reject);
  });

  return total;
}

async function main() {
  const db = new PrismaClient();
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const samplesFile = path.join(outDir, "quote_samples.csv");
    const driftFile = path.join(outDir, "quote_drift.csv");

    const samples = await exportTable(db.quoteSample, SAMPLE_COLUMNS, "sampledAt", samplesFile);
    const drift = await exportTable(db.quoteDrift, DRIFT_COLUMNS, "requotedAt", driftFile);

    console.log(`${samples} rows -> ${samplesFile}`);
    console.log(`${drift} rows -> ${driftFile}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
