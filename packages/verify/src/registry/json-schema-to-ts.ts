import { isRecord } from "./is-record";

export type JsonSchemaToTsOptions = {
  /** Type name for a `$ref`. Refs it doesn't name become `unknown`. */
  refName?: (ref: string) => string | undefined;
  /** Indent level (2 spaces each) the output starts at, for nesting it inside other generated code. */
  indent?: number;
};

type RefName = (ref: string) => string | undefined;

// Tracks how a type was built so arrays and intersections know when to add parens.
type TsType = { text: string; kind: "single" | "union" | "intersection" };

/** Output past this many characters is refused, so a hostile schema can't hang or exhaust `pull`. */
export const MAX_OUTPUT_LENGTH = 5_000_000;

// A Map, so `type: "constructor"` doesn't find Object.prototype members.
const primitiveTypes = new Map([
  ["string", "string"],
  ["number", "number"],
  ["integer", "number"],
  ["boolean", "boolean"],
  ["null", "null"],
]);

/**
 * Covers what Standard JSON Schema libraries emit for JSON data. Validation-only
 * keywords (format, pattern, minimum, ...) don't change the type and are
 * ignored; anything it doesn't know becomes `unknown`.
 */
export function jsonSchemaToTs(schema: unknown, options: JsonSchemaToTsOptions = {}): string {
  const { refName = () => undefined, indent = 0 } = options;
  return convert(schema, indent, refName).text;
}

function convert(schema: unknown, depth: number, refName: RefName): TsType {
  if (schema === true) return single("unknown");
  if (schema === false) return single("never");
  if (!isRecord(schema)) return single("unknown");
  if (typeof schema.$ref === "string") return single(refName(schema.$ref) ?? "unknown");
  if (schema.const !== undefined) return single(JSON.stringify(schema.const));
  if (Array.isArray(schema.enum)) return union(schema.enum.map((value) => single(JSON.stringify(value))));

  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) return union(variants.map((variant) => convert(variant, depth, refName)));
  if (Array.isArray(schema.allOf)) {
    return intersection(schema.allOf.map((part) => convert(part, depth, refName)));
  }

  const { type } = schema;
  // Deduped: each entry converts the whole schema again, so repeats nest exponentially.
  if (Array.isArray(type)) {
    return union([...new Set(type)].map((each) => convert({ ...schema, type: each }, depth, refName)));
  }
  if (type === "object") return objectType(schema, depth, refName);
  if (type === "array") return arrayType(schema, depth, refName);
  if (typeof type === "string") return single(primitiveTypes.get(type) ?? "unknown");
  return single("unknown");
}

function objectType(schema: Record<string, unknown>, depth: number, refName: RefName): TsType {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const extra = schema.additionalProperties;
  const keys = Object.keys(properties);

  if (keys.length === 0 && extra === false) return single("Record<string, never>");
  if (keys.length === 0 && (extra === undefined || extra === true)) {
    return single("Record<string, unknown>");
  }
  if (keys.length === 0) return single(`Record<string, ${convert(extra, depth, refName).text}>`);

  const pad = "  ".repeat(depth + 1);
  const lines = keys.map((key) => {
    const optional = required.includes(key) ? "" : "?";
    return `${pad}${propertyKey(key)}${optional}: ${convert(properties[key], depth + 1, refName).text};`;
  });
  // A typed index signature would have to accept every named property's type
  // too, so with named properties present the extra keys are `unknown`.
  if (extra !== undefined && extra !== false) lines.push(`${pad}[key: string]: unknown;`);
  return single(`{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`);
}

/**
 * Strict JSON Schema makes every prefixItems entry optional and the tuple open
 * unless minItems/items say otherwise, but zod emits plain tuples that way
 * (and `z.tuple([a, b.optional()])` identically). Like other TS generators we
 * read a bare prefixItems as a fixed tuple and honor explicit minItems,
 * maxItems and items.
 */
function arrayType(schema: Record<string, unknown>, depth: number, refName: RefName): TsType {
  const { prefixItems, items, minItems, maxItems } = schema;
  if (!Array.isArray(prefixItems)) {
    if (items === undefined) return single("unknown[]");
    return single(arrayOf(convert(items, depth, refName)));
  }

  const required = typeof minItems === "number" ? minItems : prefixItems.length;
  const max = typeof maxItems === "number" ? maxItems : Number.POSITIVE_INFINITY;
  const members = prefixItems
    .slice(0, Math.max(0, max))
    .map((item, index) => {
      const member = convert(item, depth, refName);
      if (index < required) return member.text;
      return member.kind === "single" ? `${member.text}?` : `(${member.text})?`;
    });
  if (items === undefined || items === false || max <= prefixItems.length) {
    return single(`[${members.join(", ")}]`);
  }
  const rest = arrayOf(convert(items, depth, refName));
  if (members.length === 0) return single(rest);
  return single(`[${members.join(", ")}, ...${rest}]`);
}

function arrayOf(item: TsType): string {
  return item.kind === "single" ? `${item.text}[]` : `(${item.text})[]`;
}

function propertyKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

function single(text: string): TsType {
  return tsType(text, "single");
}

function union(types: TsType[]): TsType {
  const texts = [...new Set(types.map((type) => type.text))];
  const [first] = types;
  if (!first) return single("never");
  if (texts.length === 1) return first;
  return tsType(texts.join(" | "), "union");
}

function intersection(types: TsType[]): TsType {
  const [first] = types;
  if (!first) return single("unknown");
  if (types.length === 1) return first;
  const parts = types.map((type) => (type.kind === "union" ? `(${type.text})` : type.text));
  return tsType(parts.join(" & "), "intersection");
}

// Every type is built here, so an oversized one fails as soon as it exists.
function tsType(text: string, kind: TsType["kind"]): TsType {
  if (text.length > MAX_OUTPUT_LENGTH) {
    const limit = MAX_OUTPUT_LENGTH.toLocaleString("en-US");
    throw new Error(`a schema generates over ${limit} characters of types`);
  }
  return { text, kind };
}
