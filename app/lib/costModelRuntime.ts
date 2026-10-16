/**
 * Loads the cost model the advisor serves from: models/cost-model.json (the
 * Colab model) when present, else the committed example, labelled as such
 * everywhere it is shown. Validated against the schema, and its self-test
 * and feature-test vectors re-run, once per process; an artifact that fails
 * is not served.
 */

import fs from "node:fs";
import path from "node:path";
import { validateCostModel, type CostModel } from "./costModel";

const CANDIDATES = [
  process.env.COST_MODEL_PATH,
  "models/cost-model.json",
  "models/cost-model.example.json",
].filter(Boolean) as string[];

let cached: { model: CostModel | null; file: string | null; exampleOnly: boolean; error: string | null } | null = null;

export function loadCostModel() {
  if (cached) return cached;

  const file = CANDIDATES.map((f) => path.resolve(f)).find((f) => fs.existsSync(f)) ?? null;
  if (!file) {
    cached = { model: null, file: null, exampleOnly: false, error: "no cost model artifact found" };
    console.error(`[advisor] ${cached.error}; advice is unavailable`);
    return cached;
  }

  const schema = JSON.parse(fs.readFileSync(path.resolve("models/cost-model.schema.json"), "utf8"));
  const result = validateCostModel(JSON.parse(fs.readFileSync(file, "utf8")), schema);

  if (!result.ok || !result.model) {
    cached = { model: null, file, exampleOnly: false, error: `${path.basename(file)} fails validation: ${result.errors.slice(0, 3).join("; ")}` };
    console.error(`[advisor] ${cached.error}; advice is unavailable`);
    return cached;
  }

  const exampleOnly = /example/i.test(result.model.producer);
  if (exampleOnly) {
    console.warn(`[advisor] serving the EXAMPLE cost model (${result.model.modelVersion}); put the Colab model at models/cost-model.json`);
  } else {
    console.log(`[advisor] cost model ${result.model.modelVersion} (${result.model.producer})`);
  }

  cached = { model: result.model, file, exampleOnly, error: null };
  return cached;
}
