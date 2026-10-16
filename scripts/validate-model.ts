/**
 * Checks a cost model artifact before anything serves it:
 *
 *   npm run validate:model                      models/cost-model.json
 *   npm run validate:model -- path/to/file.json
 *
 * 1. Structure against models/cost-model.schema.json.
 * 2. Every selfTestVector re-run through the TypeScript inference path
 *    (app/lib/costModel.ts); numbers must match the notebook's own outputs.
 * 3. Every featureTestVector re-run through the TypeScript feature code; the
 *    volatility must match the notebook's.
 *
 * (2) and (3) are the guard against train/serve skew: the notebook
 * engineers features and evaluates the model in numpy, the app in
 * TypeScript, and without this they can drift apart silently.
 *
 * Exits non-zero on any failure.
 */

import fs from "node:fs";
import path from "node:path";
import { validateCostModel } from "../app/lib/costModel";

const file = path.resolve(process.argv[2] || "models/cost-model.json");
const schema = JSON.parse(fs.readFileSync(path.resolve("models/cost-model.schema.json"), "utf8"));

if (!fs.existsSync(file)) {
  console.error(`No artifact at ${file}.`);
  process.exit(1);
}

const result = validateCostModel(JSON.parse(fs.readFileSync(file, "utf8")), schema);

console.log(`artifact   ${path.relative(process.cwd(), file)}`);

if (!result.model) {
  console.error(`\nFAILED: does not match the schema (${result.errors.length} problems)`);
  for (const e of result.errors.slice(0, 40)) console.error(`  ${e}`);
  process.exit(1);
}

const m = result.model;
console.log(`version    ${m.modelVersion}`);
console.log(`producer   ${m.producer}`);
console.log(`trained    ${m.trainedAt}`);
console.log(`data       ${m.datasetRowCounts.quoteSamples} samples, ${m.datasetRowCounts.quoteDrift} drift rows, ${m.datasetTimeRange.from} .. ${m.datasetTimeRange.to}`);
console.log(`split      time, cutoff ${m.split.cutoff}; train impact ${m.split.trainRows.impact} / drift ${m.split.trainRows.drift}, test impact ${m.split.testRows.impact} / drift ${m.split.testRows.drift}`);

console.log("\nmetrics (test split; every number with its n)");
for (const [target, models] of Object.entries(m.metrics)) {
  for (const [model, byDepth] of Object.entries(models)) {
    for (const [depth, metric] of Object.entries(byDepth)) {
      const parts = Object.entries(metric)
        .filter(([k]) => k !== "n")
        .map(([k, v]) => `${k} ${v === null ? "-" : Number(v).toFixed(3)}`);
      console.log(`  ${target.padEnd(8)} ${model.padEnd(14)} ${depth.padEnd(6)} n=${String(metric.n).padStart(6)}  ${parts.join("  ")}`);
    }
  }
}

const passed = (tests: { ok: boolean }[]) => tests.filter((t) => t.ok).length;
console.log(`\nself tests     ${passed(result.selfTests)}/${result.selfTests.length} agree with the TypeScript inference path`);
console.log(`feature tests  ${passed(result.featureTests)}/${result.featureTests.length} agree with the TypeScript feature code`);

if (!result.ok) {
  console.error(`\nFAILED (${result.errors.length} problems):`);
  for (const e of result.errors.slice(0, 40)) console.error(`  ${e}`);
  process.exit(1);
}

console.log("\nOK: safe to serve.");
