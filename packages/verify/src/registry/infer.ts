import { isRecord } from "./is-record";

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A JSON Schema every sample matches, for senders who only have example
 * payloads: a property is required when every sample has it, arrays merge
 * their items, and a value seen with several types becomes a union. The first
 * samples are kept as `examples`, so consumers see real payloads.
 */
export function inferSchema(samples: unknown[]): Record<string, unknown> {
  return { ...infer(samples), examples: samples.slice(0, 3) };
}

function infer(values: unknown[]): Record<string, unknown> {
  const groups = new Map<string, unknown[]>();
  for (const value of values) {
    const kind = kindOf(value);
    groups.set(kind, [...(groups.get(kind) ?? []), value]);
  }
  // 1 and 1.5 seen for the same property make it a number, not integer | number.
  const integers = groups.get("integer");
  const numbers = groups.get("number");
  if (integers && numbers) {
    groups.set("number", [...numbers, ...integers]);
    groups.delete("integer");
  }
  const schemas = [...groups].map(([kind, members]) => inferKind(kind, members));
  const [only] = schemas;
  if (schemas.length === 1 && only) return only;
  if (schemas.every(isPlainType)) return { type: schemas.map((schema) => schema.type) };
  return { anyOf: schemas };
}

function inferKind(kind: string, values: unknown[]): Record<string, unknown> {
  if (kind === "array") return { type: "array", items: infer(values.flatMap((value) => (Array.isArray(value) ? value : []))) };
  if (kind === "object") return inferObject(values.filter(isRecord));
  if (kind === "string" && values.every((value) => typeof value === "string" && ISO_DATE_TIME.test(value))) {
    return { type: "string", format: "date-time" };
  }
  return { type: kind };
}

function inferObject(objects: Record<string, unknown>[]): Record<string, unknown> {
  // A Map keeps first-seen order and treats a `__proto__` key like any other.
  const valuesByKey = new Map<string, unknown[]>();
  for (const object of objects) {
    for (const [key, value] of Object.entries(object)) valuesByKey.set(key, [...(valuesByKey.get(key) ?? []), value]);
  }
  const properties = Object.fromEntries([...valuesByKey].map(([key, values]) => [key, infer(values)]));
  const required = [...valuesByKey].filter(([, values]) => values.length === objects.length).map(([key]) => key);
  return { type: "object", properties, required };
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** A schema that's only `type`, so a union of them can be one `type` array. */
function isPlainType(schema: Record<string, unknown>): boolean {
  return Object.keys(schema).length === 1 && typeof schema.type === "string";
}
