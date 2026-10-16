/**
 * A small JSON Schema checker covering exactly the keywords
 * models/cost-model.schema.json uses: type, const, enum, required,
 * properties, additionalProperties, items, minItems, maxItems, minimum,
 * maximum, anyOf and local $ref. Anything else in a schema is ignored, so
 * keep the contract to these.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Schema = Record<string, any>;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === "number" && actual === "integer");
}

export function validateJson(value: unknown, schema: Schema, root: Schema = schema, at = "$"): string[] {
  if (schema.$ref) {
    const name = String(schema.$ref).replace("#/$defs/", "");
    const target = root.$defs?.[name];
    if (!target) return [`${at}: unknown $ref ${schema.$ref}`];
    return validateJson(value, target, root, at);
  }

  const errors: string[] = [];

  if (schema.anyOf) {
    const ok = (schema.anyOf as Schema[]).some((s) => validateJson(value, s, root, at).length === 0);
    if (!ok) errors.push(`${at}: matches none of anyOf`);
    return errors;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t: string) => matchesType(value, t))) {
      return [`${at}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
    }
  }

  if ("const" in schema && value !== schema.const) {
    errors.push(`${at}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${at}: not a finite number`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at}: needs at least ${schema.minItems} items, has ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${at}: allows at most ${schema.maxItems} items, has ${value.length}`);
    }
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validateJson(item, schema.items, root, `${at}[${i}]`)));
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${at}: missing ${key}`);
    }
    const props: Record<string, Schema> = schema.properties ?? {};
    for (const [key, child] of Object.entries(obj)) {
      if (props[key]) errors.push(...validateJson(child, props[key], root, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateJson(child, schema.additionalProperties, root, `${at}.${key}`));
      }
    }
  }

  return errors;
}
