import { componentName } from "./component-ref";
import type { CodegenContext } from "./generate";
import { isRecord } from "./is-record";
import { MAX_OUTPUT_LENGTH, getDescription } from "./json-schema-to-ts";
import { type RegistryEvent, type RegistryModel, eventKey } from "./model";
import { goPackageName, uniqueNames, words } from "./names";

// How a type says "absent": structs and scalars need a pointer, slices, maps and raw JSON are nil already.
type Shape = "struct" | "scalar" | "list" | "raw";

type GoType = { isNullable: boolean } & (
  | { kind: "named"; name: string; shape: Shape }
  | { kind: "ref"; key: string; name: string }
  | { kind: "slice"; item: GoType }
  | { kind: "map"; value: GoType }
);

type Field = { name: string; jsonName: string; type: GoType; isOptional: boolean; doc: string[] };

type StructDeclaration = {
  kind: "struct";
  name: string;
  doc: string[];
  fields: Field[];
  isInComponent: boolean;
  isEvent: boolean;
};

type EnumDeclaration = { kind: "enum"; name: string; doc: string[]; values: { name: string; value: string }[] };

type TypeDeclaration = { kind: "type"; name: string; doc: string[]; type: GoType };

type Declaration = StructDeclaration | EnumDeclaration | TypeDeclaration;

type Generator = {
  model: RegistryModel;
  names: { claim: (name: string) => string };
  components: Map<string, unknown>;
  componentNames: Map<string, string>;
  componentTypes: Map<string, GoType>;
  resolved: Map<string, Resolved | null>;
  shared: Map<string, GoType>;
  declarations: Declaration[];
  outputLength: number;
  usesJSON: boolean;
};

/** Where a type is being converted: the name a struct or enum declared there gets. */
type Position = { name: string; isClaimed: boolean; isInComponent: boolean };

type Merged = { properties: Map<string, unknown>; required: Set<unknown> };

type Resolved = { shape: Shape; isNullable: boolean };

// Every exported identifier the runtime declares, so no event or schema type takes one.
const RUNTIME_NAMES = [
  "DefaultTolerance",
  "Error",
  "Event",
  "Parse",
  "Reason",
  "ReasonInvalidID",
  "ReasonInvalidJSON",
  "ReasonInvalidSecret",
  "ReasonInvalidSignature",
  "ReasonInvalidTimestamp",
  "ReasonMissingHeaders",
  "ReasonTimestampOutOfTolerance",
  "UnknownEvent",
  "Verifier",
  "Verify",
  "VerifySignature",
];

// A Map, so `type: "constructor"` doesn't find Object.prototype members.
const primitiveTypes = new Map([
  ["string", "string"],
  ["integer", "int64"],
  ["number", "float64"],
  ["boolean", "bool"],
]);

const initialisms = new Set([
  "acl", "api", "ascii", "cpu", "css", "dns", "eof", "guid", "html", "http", "https", "id", "ip", "json", "lhs",
  "qps", "ram", "rhs", "rpc", "sla", "smtp", "sql", "ssh", "tcp", "tls", "ttl", "udp", "ui", "uid", "uuid", "uri",
  "url", "utf8", "vm", "xml", "xmpp", "xsrf", "xss",
]);

const SHAPING_KEYWORDS = [
  "$ref", "const", "enum", "anyOf", "oneOf", "allOf", "type", "properties", "additionalProperties", "items", "prefixItems",
];

// encoding/json ignores a tag name with other characters and matches the Go field name instead.
const JSON_NAME = /^[\p{L}\p{Nd}!#$%&()*+\-./:;<=>?@[\]^_{|}~ ]+$/u;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Characters Go rejects in source (NUL, BOM) or that could disguise the code around a comment.
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const curlyQuotes = new Map([
  ["``", "“"],
  ["''", "”"],
]);

const stringEscapes = new Map([
  ["\\", "\\\\"],
  ['"', '\\"'],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
]);

const RAW: GoType = { kind: "named", name: "json.RawMessage", shape: "raw", isNullable: false };

const ANY: GoType = { kind: "named", name: "any", shape: "raw", isNullable: false };

/**
 * One package per registry: a struct per event (and per nested object and
 * component schema), Standard Webhooks verification matching
 * @typedhook/verify, and, when the events carry their name, `Parse`/`Verify`
 * returning an `Event` to type-switch on.
 */
export function goCode({ registry, name, model }: CodegenContext): string {
  const pkg = goPackageName(name);
  const names = uniqueNames(RUNTIME_NAMES);
  const events = model.events.map((event) => ({ event, name: names.claim(goName(event.name, "Event")) }));
  const eventNames = new Set(events.map((event) => event.name));
  const componentNames = new Map(
    Object.keys(model.schemas)
      .sort()
      .map((key) => {
        const base = goName(key, "Schema");
        // toOpenAPI hoists a recursive event's data under the event's own name.
        return [key, names.claim(eventNames.has(base) ? `${base}Data` : base)];
      }),
  );
  const generator: Generator = {
    model,
    names,
    components: new Map(Object.entries(model.schemas)),
    componentNames,
    componentTypes: new Map(),
    resolved: new Map(),
    shared: new Map(),
    declarations: [],
    outputLength: 0,
    usesJSON: false,
  };
  for (const { event, name } of events) declareEvent(generator, event, name);
  for (const [key, name] of componentNames) declareComponent(generator, key, name);

  const types = generator.declarations.map((declaration) => renderDeclaration(generator, declaration));
  const { discriminator } = model;
  const keys = events.map(({ event, name }) => ({ key: eventKey(model, event), name }));
  const parse = discriminator === null ? [] : [parseCode(registry, discriminator.property, keys)];
  const sections = [
    packageCode(pkg, registry, discriminator !== null || generator.usesJSON),
    ...parse,
    verifyCode(pkg, discriminator !== null),
    ...types,
  ];
  return `\n${sections.join("\n\n")}\n`;
}

function declareEvent(generator: Generator, event: RegistryEvent, name: string): void {
  const { description = "" } = event;
  const key = eventKey(generator.model, event);
  const doc = docLines(`${name} is the ${goString(key)} event.\n${description}`);
  spend(generator, doc.join("").length);
  const at = { name, isClaimed: true, isInComponent: false };
  if (generator.model.discriminator === null) {
    declareType(generator, at, doc, event.payload);
    return;
  }
  // Parse needs a struct of the event's own to hang isEvent on, even when the payload is a $ref.
  const merged = mergeParts(objectParts(generator, event.payload, new Set()));
  Object.assign(structType(generator, merged, at), { doc, isEvent: true });
}

function declareComponent(generator: Generator, key: string, name: string): void {
  const schema = generator.components.get(key);
  const doc = docLines(`${name} is the ${goString(key)} schema.\n${getDescription(schema) ?? ""}`);
  spend(generator, doc.join("").length);
  const at = { name, isClaimed: true, isInComponent: true };
  generator.componentTypes.set(key, declareType(generator, at, doc, schema));
}

/** Declares `at.name` as the schema's type, unless converting it declared a struct or enum of that name. */
function declareType(generator: Generator, at: Position, doc: string[], schema: unknown): GoType {
  const index = generator.declarations.length;
  const type = convert(generator, schema, at);
  const declared = generator.declarations.at(index);
  if (declared?.name === at.name) declared.doc = doc;
  else generator.declarations.splice(index, 0, { kind: "type", name: at.name, doc, type });
  return type;
}

function convert(generator: Generator, schema: unknown, at: Position): GoType {
  if (!isRecord(schema)) return RAW;
  if (typeof schema.$ref === "string") return refType(generator, schema.$ref);
  if (schema.const !== undefined) return enumType(generator, [schema.const], at);
  if (Array.isArray(schema.enum)) return enumType(generator, schema.enum, at);
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) return unionType(generator, schema, variants, at);
  if (Array.isArray(schema.allOf)) return allOfType(generator, schema, schema.allOf, at);
  const { type } = schema;
  if (Array.isArray(type)) return typeListType(generator, schema, type, at);
  if (isObjectLike(schema)) return objectType(generator, [schema], at);
  if (type === "array") return arrayType(generator, schema, at);
  const primitive = typeof type === "string" ? primitiveTypes.get(type) : undefined;
  return primitive === undefined ? RAW : scalar(primitive);
}

function refType(generator: Generator, ref: string): GoType {
  const key = componentName(ref);
  const name = key === null ? undefined : generator.componentNames.get(key);
  if (key === null || name === undefined) return RAW;
  return { kind: "ref", key, name, isNullable: false };
}

/** Strings with two or more values get a named type with a constant per value. */
function enumType(generator: Generator, values: unknown[], at: Position): GoType {
  const present = values.filter((value) => value !== null);
  const isNullable = present.length < values.length;
  const type = valuesType(present);
  if (type === null) return RAW;
  const strings = [...new Set(present.filter((value): value is string => typeof value === "string"))];
  if (type !== "string" || strings.length < 2) return { ...scalar(type), isNullable };
  const enumeration = share(generator, at, { enum: strings }, () => {
    const name = at.isClaimed ? at.name : generator.names.claim(at.name);
    const constants = strings.map((value) => {
      const constant = generator.names.claim(`${name}${goName(value, "Value")}`);
      spend(generator, constant.length + value.length);
      return { name: constant, value };
    });
    generator.declarations.push({ kind: "enum", name, doc: [], values: constants });
    return named(name, "scalar");
  });
  return { ...enumeration, isNullable };
}

/**
 * A null variant makes the rest nullable, string constants merge into one
 * enum and variants of one scalar type are that type. Other unions have no Go
 * type, so they stay raw JSON.
 */
function unionType(generator: Generator, schema: Record<string, unknown>, variants: unknown[], at: Position): GoType {
  const present = variants.filter((variant) => !isNullSchema(variant));
  const isNullable = present.length < variants.length;
  // Variants that only constrain (`required`, `minLength`, ...) leave the schema's own type.
  if (present.every(isNeutral)) return withNullable(convert(generator, omit(schema, ["anyOf", "oneOf"]), at), isNullable);
  const [first] = present;
  if (present.length === 1) return withNullable(convert(generator, first, at), isNullable);
  const values = present.map(enumValues);
  if (values.every((list): list is unknown[] => list !== null)) {
    return withNullable(enumType(generator, values.flat(), at), isNullable);
  }
  const types = [...new Set(present.map(scalarTypeOf))];
  const [type] = types;
  if (types.length === 1 && type !== null) return { ...scalar(type), isNullable };
  return RAW;
}

function allOfType(generator: Generator, schema: Record<string, unknown>, parts: unknown[], at: Position): GoType {
  const rest = omit(schema, ["allOf"]);
  const shaping = parts.filter((part) => !isNeutral(part));
  const [first] = shaping;
  if (isNeutral(rest) && shaping.length === 1) return convert(generator, first, at);
  const objects = objectParts(generator, schema, new Set());
  if (objects.length > 0) return objectType(generator, objects, at);
  if (shaping.length === 0) return convert(generator, rest, at);
  return RAW;
}

// Deduped like the TypeScript generator, though only a single non-null type converts.
function typeListType(generator: Generator, schema: Record<string, unknown>, types: unknown[], at: Position): GoType {
  const unique = [...new Set(types)];
  const present = unique.filter((type) => type !== "null");
  const isNullable = present.length < unique.length;
  const [first] = present;
  if (present.length !== 1) return RAW;
  return withNullable(convert(generator, { ...schema, type: first }, at), isNullable);
}

/** A struct for named properties; without any, a map, or `struct{}` when nothing else is allowed. */
function objectType(generator: Generator, parts: Record<string, unknown>[], at: Position): GoType {
  const merged = mergeParts(parts);
  if (merged.properties.size > 0) {
    return share(generator, at, parts, () => named(structType(generator, merged, at).name, "struct"));
  }
  const [first] = parts;
  const extra = parts.length === 1 ? first.additionalProperties : undefined;
  if (extra === false) return named("struct{}", "struct");
  if (extra === undefined || isNeutral(extra)) return { kind: "map", value: ANY, isNullable: false };
  return { kind: "map", value: convert(generator, extra, child(at, `${at.name}Value`)), isNullable: false };
}

// Extra properties next to named ones are dropped: encoding/json has no struct field for "the rest".
function structType(generator: Generator, { properties, required }: Merged, at: Position): StructDeclaration {
  const name = at.isClaimed ? at.name : generator.names.claim(at.name);
  const declaration: StructDeclaration = {
    kind: "struct",
    name,
    doc: [],
    fields: [],
    isInComponent: at.isInComponent,
    isEvent: false,
  };
  generator.declarations.push(declaration);
  spend(generator, name.length);
  const fieldNames = uniqueNames([]);
  for (const [jsonName, schema] of properties) {
    if (!JSON_NAME.test(jsonName)) continue;
    const fieldName = fieldNames.claim(goName(jsonName, "Field"));
    const doc = docLines(getDescription(schema) ?? "");
    spend(generator, fieldName.length + jsonName.length + doc.join("").length);
    const type = convert(generator, schema, child(at, `${name}${fieldName}`));
    declaration.fields.push({ name: fieldName, jsonName, type, isOptional: !required.has(jsonName), doc });
  }
  return declaration;
}

/** Go has no tuples: a prefixItems array is a slice of the members' scalar type when they share one. */
function arrayType(generator: Generator, schema: Record<string, unknown>, at: Position): GoType {
  const { prefixItems, items } = schema;
  if (!Array.isArray(prefixItems)) {
    const item = items === undefined ? RAW : convert(generator, items, child(at, `${at.name}Item`));
    return { kind: "slice", item, isNullable: false };
  }
  const members = items === undefined || items === false ? prefixItems : [...prefixItems, items];
  const types = [...new Set(members.map(scalarTypeOf))];
  const [type] = types;
  const item = types.length === 1 && type !== null ? scalar(type) : RAW;
  return { kind: "slice", item, isNullable: false };
}

/** The object schemas an allOf or a payload merges, through `$ref` and `allOf` like model.ts finds the discriminator. */
function objectParts(generator: Generator, schema: unknown, seen: Set<unknown>): Record<string, unknown>[] {
  if (!isRecord(schema) || seen.has(schema)) return [];
  seen.add(schema);
  if (typeof schema.$ref === "string") {
    const key = componentName(schema.$ref);
    return key === null ? [] : objectParts(generator, generator.components.get(key), seen);
  }
  const nested = Array.isArray(schema.allOf) ? schema.allOf.flatMap((part) => objectParts(generator, part, seen)) : [];
  return isRecord(schema.properties) || schema.type === "object" ? [...nested, schema] : nested;
}

/**
 * Declares a nested type once per distinct schema: documents like GitHub's
 * repeat whole objects (a repository, a user) in every event that has one.
 */
function share(generator: Generator, at: Position, schema: unknown, declare: () => GoType): GoType {
  if (at.isClaimed) return declare();
  // Pointers inside a struct depend on whether it's declared in a component.
  const key = `${at.isInComponent}${JSON.stringify(schema)}`;
  const known = generator.shared.get(key);
  if (known !== undefined) return known;
  const type = declare();
  generator.shared.set(key, type);
  return type;
}

function mergeParts(parts: Record<string, unknown>[]): Merged {
  // A Map, so a `__proto__` property is a property like any other.
  const properties = new Map<string, unknown>();
  const required = new Set<unknown>();
  for (const part of parts) {
    if (isRecord(part.properties)) {
      for (const [key, value] of Object.entries(part.properties)) properties.set(key, value);
    }
    if (Array.isArray(part.required)) for (const key of part.required) required.add(key);
  }
  return { properties, required };
}

function enumValues(schema: unknown): unknown[] | null {
  if (!isRecord(schema)) return null;
  if (schema.const !== undefined) return [schema.const];
  return Array.isArray(schema.enum) ? schema.enum : null;
}

/** The Go type of a constant, an enum or a bare primitive, else null. */
function scalarTypeOf(schema: unknown): string | null {
  const values = enumValues(schema);
  if (values !== null) return valuesType(values.filter((value) => value !== null));
  if (!isRecord(schema) || typeof schema.type !== "string" || !isNeutral(omit(schema, ["type"]))) return null;
  return primitiveTypes.get(schema.type) ?? null;
}

function valuesType(values: unknown[]): string | null {
  const types = new Set(values.map(valueType));
  if (types.size === 2 && types.has("int64") && types.has("float64")) return "float64";
  const [type] = types;
  return types.size === 1 ? type : null;
}

function valueType(value: unknown): string | null {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "bool";
  if (typeof value !== "number") return null;
  return Number.isInteger(value) ? "int64" : "float64";
}

function isObjectLike(schema: Record<string, unknown>): boolean {
  return schema.type === "object" || (schema.type === undefined && isRecord(schema.properties));
}

function isNullSchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.type === "null" || schema.const === null) return true;
  return Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((value) => value === null);
}

/** Says nothing about the type: `true`, `{}`, or only validation keywords. */
function isNeutral(schema: unknown): boolean {
  if (schema === true) return true;
  return isRecord(schema) && SHAPING_KEYWORDS.every((keyword) => schema[keyword] === undefined);
}

function omit(schema: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !keys.includes(key)));
}

function child(at: Position, name: string): Position {
  return { ...at, name, isClaimed: false };
}

function named(name: string, shape: Shape): GoType {
  return { kind: "named", name, shape, isNullable: false };
}

function scalar(name: string): GoType {
  return named(name, "scalar");
}

function withNullable(type: GoType, isNullable: boolean): GoType {
  return { ...type, isNullable: type.isNullable || isNullable };
}

// Counted as it's built, so a schema that inlines itself over and over fails before it exhausts memory.
function spend(generator: Generator, length: number): void {
  generator.outputLength += length;
  if (generator.outputLength > MAX_OUTPUT_LENGTH) {
    const limit = MAX_OUTPUT_LENGTH.toLocaleString("en-US");
    throw new Error(`a schema generates over ${limit} characters of Go`);
  }
}

function renderDeclaration(generator: Generator, declaration: Declaration): string {
  const doc = declaration.doc.map((line) => `// ${line}`);
  if (declaration.kind === "struct") return [...doc, ...renderStruct(generator, declaration)].join("\n");
  if (declaration.kind === "enum") return [...doc, ...renderEnum(declaration)].join("\n");
  return [...doc, renderTypeDeclaration(generator, declaration)].join("\n");
}

function renderStruct(generator: Generator, declaration: StructDeclaration): string[] {
  const { name, fields, isEvent } = declaration;
  const lines =
    fields.length === 0 ? [`type ${name} struct{}`] : [`type ${name} struct {`, ...fieldLines(generator, declaration), "}"];
  if (isEvent) lines.push("", `func (*${name}) isEvent() {}`);
  return lines;
}

// gofmt aligns names, types and tags into columns, restarting after every comment.
function fieldLines(generator: Generator, { fields, isInComponent }: StructDeclaration): string[] {
  const blocks: { field: Field; type: string }[][] = [];
  for (const field of fields) {
    const row = { field, type: fieldType(generator, field, isInComponent) };
    const block = blocks.at(-1);
    if (block === undefined || field.doc.length > 0) blocks.push([row]);
    else block.push(row);
  }
  return blocks.flatMap((block) => {
    const nameWidth = block.reduce((width, { field }) => Math.max(width, field.name.length), 0);
    const typeWidth = block.reduce((width, { type }) => Math.max(width, type.length), 0);
    return block.flatMap(({ field, type }) => [
      ...field.doc.map((line) => `\t// ${line}`),
      `\t${field.name.padEnd(nameWidth)} ${type.padEnd(typeWidth)} \`${jsonTag(field.jsonName, field.isOptional)}\``,
    ]);
  });
}

function fieldType(generator: Generator, { type, isOptional }: Field, isInComponent: boolean): string {
  const shape = shapeOf(generator, type);
  // A struct component inside a component may lead back to it; the pointer keeps the type finite.
  const mayRecurse = isInComponent && type.kind === "ref" && shape === "struct";
  const isPointer = canPoint(shape) && (isOptional || isNullable(generator, type) || mayRecurse);
  return isPointer ? `*${typeText(generator, type)}` : typeText(generator, type);
}

function elementText(generator: Generator, type: GoType): string {
  const isPointer = canPoint(shapeOf(generator, type)) && isNullable(generator, type);
  return isPointer ? `*${typeText(generator, type)}` : typeText(generator, type);
}

function typeText(generator: Generator, type: GoType): string {
  if (type.kind === "named") {
    if (type.name === "json.RawMessage") generator.usesJSON = true;
    return type.name;
  }
  if (type.kind === "ref") return type.name;
  if (type.kind === "slice") return `[]${elementText(generator, type.item)}`;
  return `map[string]${elementText(generator, type.value)}`;
}

function renderEnum({ name, values }: EnumDeclaration): string[] {
  const width = values.reduce((max, value) => Math.max(max, value.name.length), 0);
  const constants = values.map((value) => `\t${value.name.padEnd(width)} ${name} = ${goString(value.value)}`);
  return [`type ${name} string`, "", "const (", ...constants, ")"];
}

// Aliases where they can't loop; slices and maps are defined types, which may refer back to themselves.
function renderTypeDeclaration(generator: Generator, { name, type }: TypeDeclaration): string {
  if (type.kind === "ref") {
    if (resolveRef(generator, type.key) !== null) return `type ${name} = ${type.name}`;
    generator.usesJSON = true;
    return `type ${name} = json.RawMessage`;
  }
  if (type.kind === "named" && type.shape !== "struct") return `type ${name} = ${typeText(generator, type)}`;
  return `type ${name} ${typeText(generator, type)}`;
}

function shapeOf(generator: Generator, type: GoType): Shape {
  if (type.kind === "named") return type.shape;
  if (type.kind === "ref") return resolveRef(generator, type.key)?.shape ?? "raw";
  return "list";
}

function isNullable(generator: Generator, type: GoType): boolean {
  if (type.isNullable || type.kind !== "ref") return type.isNullable;
  return resolveRef(generator, type.key)?.isNullable === true;
}

function canPoint(shape: Shape): boolean {
  return shape === "struct" || shape === "scalar";
}

/** What a component that is only a ref to another ends at; null when such refs go in a circle. */
function resolveRef(generator: Generator, key: string): Resolved | null {
  const cached = generator.resolved.get(key);
  if (cached !== undefined) return cached;
  const seen = new Set<string>();
  let isNullable = false;
  let next = key;
  let resolved: Resolved | null = null;
  while (!seen.has(next)) {
    seen.add(next);
    const type = generator.componentTypes.get(next);
    if (type === undefined) break;
    isNullable ||= type.isNullable;
    if (type.kind !== "ref") {
      resolved = { shape: shapeOf(generator, type), isNullable };
      break;
    }
    next = type.key;
  }
  generator.resolved.set(key, resolved);
  return resolved;
}

// `json:"-"` would skip the field; `-,` names it "-".
function jsonTag(name: string, isOptional: boolean): string {
  if (isOptional) return `json:"${name},omitempty"`;
  if (name === "-") return 'json:"-,"';
  return `json:"${name}"`;
}

export function goName(text: string, fallback: string): string {
  const name = words(text)
    .map((word) => (initialisms.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("");
  if (name === "") return fallback;
  return /^\d/.test(name) ? `X${name}` : name;
}

/** A Go string literal with everything outside printable ASCII escaped. */
function goString(text: string): string {
  return `"${text.replace(/[^\x20-\x7E]|["\\]/gu, (char) => stringEscapes.get(char) ?? unicodeEscape(char))}"`;
}

// A lone surrogate isn't a code point Go accepts; encoding/json decodes one as U+FFFD too.
function unicodeEscape(char: string): string {
  const code = char.codePointAt(0);
  if (code === undefined || (code >= 0xd800 && code <= 0xdfff)) return "\\uFFFD";
  if (code > 0xffff) return `\\U${code.toString(16).padStart(8, "0")}`;
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * `//` lines that can't end the comment or hide code. Indentation and blank
 * lines are dropped and `` and '' become curly quotes, so the text is one
 * paragraph gofmt leaves as it is (it would turn indented or blank-separated
 * lines into code blocks, lists and headings). gofmt also moves every
 * `// +build` line to the top of the file, where it would exclude the file
 * from builds.
 */
function docLines(text: string): string[] {
  return text
    .replace(LONE_SURROGATE, "\uFFFD")
    .split(/\r\n|[\n\r\u0085\u2028\u2029]/)
    .map((line) => line.replace(HIDDEN, "").replaceAll("\t", " ").trim())
    .filter((line) => line !== "")
    .map((line) =>
      line.replace(/^\+build(?=\s|$)/, "+ build").replace(/`{3,}|``|''/g, (quotes) => curlyQuotes.get(quotes) ?? quotes),
    );
}

function packageCode(pkg: string, registry: string, usesJSON: boolean): string {
  const imports = [
    "crypto/hmac",
    "crypto/sha256",
    "encoding/base64",
    ...(usesJSON ? ["encoding/json"] : []),
    "net/http",
    "strconv",
    "strings",
    "time",
  ];
  return [
    `// Package ${pkg} holds the ${registry} webhook events and verifies their Standard Webhooks signatures.`,
    `package ${pkg}`,
    "",
    "import (",
    ...imports.map((path) => `\t"${path}"`),
    ")",
  ].join("\n");
}

function parseCode(registry: string, property: string, events: { key: string; name: string }[]): string {
  const quoted = goString(property);
  return [
    `// Event is a decoded ${registry} webhook: a pointer to one of the event types below, or *UnknownEvent.`,
    "type Event interface {",
    "\tisEvent()",
    "}",
    "",
    "// UnknownEvent is an event this package has no type for, like one added after it was generated.",
    "type UnknownEvent struct {",
    ...docLines(`Name is the payload's ${quoted} property.`).map((line) => `\t// ${line}`),
    "\tName string",
    "\tRaw  json.RawMessage",
    "}",
    "",
    "func (*UnknownEvent) isEvent() {}",
    "",
    ...docLines(`Parse decodes a payload into the event type its ${quoted} property names, or an *UnknownEvent.`).map(
      (line) => `// ${line}`,
    ),
    "func Parse(payload []byte) (Event, error) {",
    "\tvar fields map[string]json.RawMessage",
    "\tif err := json.Unmarshal(payload, &fields); err != nil {",
    "\t\treturn nil, &Error{Reason: ReasonInvalidJSON, Err: err}",
    "\t}",
    "\tvar name string",
    `\tif err := json.Unmarshal(fields[${quoted}], &name); err != nil {`,
    "\t\treturn &UnknownEvent{Raw: payload}, nil",
    "\t}",
    "\tvar event Event",
    "\tswitch name {",
    ...events.flatMap(({ key, name }) => [`\tcase ${goString(key)}:`, `\t\tevent = &${name}{}`]),
    "\tdefault:",
    "\t\treturn &UnknownEvent{Name: name, Raw: payload}, nil",
    "\t}",
    "\tif err := json.Unmarshal(payload, event); err != nil {",
    "\t\treturn nil, &Error{Reason: ReasonInvalidJSON, Err: err}",
    "\t}",
    "\treturn event, nil",
    "}",
  ].join("\n");
}

/** The same checks, order and reason codes as @typedhook/verify's createVerifier. */
function verifyCode(pkg: string, canParse: boolean): string {
  const verifyEvent = [
    "// Verify checks the signature like VerifySignature, then decodes the payload like Parse.",
    "func Verify(payload []byte, header http.Header, secret string) (Event, error) {",
    "\treturn Verifier{Secret: secret}.Verify(payload, header)",
    "}",
    "",
  ];
  const verifyEventMethod = [
    "// Verify checks the signature like VerifySignature, then decodes the payload like Parse.",
    "func (v Verifier) Verify(payload []byte, header http.Header) (Event, error) {",
    "\tif err := v.VerifySignature(payload, header); err != nil {",
    "\t\treturn nil, err",
    "\t}",
    "\treturn Parse(payload)",
    "}",
    "",
  ];
  return [
    "// DefaultTolerance is how far from now a webhook-timestamp may be when Verifier.Tolerance is zero.",
    "const DefaultTolerance = 5 * time.Minute",
    "",
    "// The signature header is the sender's to fill, so it caps the HMACs computed per request.",
    "const maxSignatureCandidates = 8",
    "",
    '// Verifier checks Standard Webhooks signatures made with Secret, a "whsec_" base64 secret or the raw secret.',
    "type Verifier struct {",
    "\tSecret string",
    "\t// Tolerance is how far from now the webhook-timestamp may be; zero means DefaultTolerance.",
    "\tTolerance time.Duration",
    "}",
    "",
    ...(canParse ? verifyEvent : []),
    "// VerifySignature checks that payload, the raw request body, was signed with secret, reading the",
    "// webhook-* headers or their svix-* equivalents.",
    "func VerifySignature(payload []byte, header http.Header, secret string) error {",
    "\treturn Verifier{Secret: secret}.VerifySignature(payload, header)",
    "}",
    "",
    ...(canParse ? verifyEventMethod : []),
    "// VerifySignature checks that payload, the raw request body, was signed with v.Secret.",
    "func (v Verifier) VerifySignature(payload []byte, header http.Header) error {",
    '\tid := headerValue(header, "Id")',
    '\ttimestamp := headerValue(header, "Timestamp")',
    '\tsignatures := headerValue(header, "Signature")',
    '\tif id == "" || timestamp == "" || signatures == "" {',
    "\t\treturn &Error{Reason: ReasonMissingHeaders}",
    "\t}",
    '\t// A "." would let another split of "{id}.{timestamp}.{body}" reuse the signature.',
    '\tif strings.Contains(id, ".") {',
    "\t\treturn &Error{Reason: ReasonInvalidID}",
    "\t}",
    "\tseconds, err := strconv.ParseInt(timestamp, 10, 64)",
    "\tif err != nil {",
    "\t\treturn &Error{Reason: ReasonInvalidTimestamp}",
    "\t}",
    "\tif !v.isFresh(seconds) {",
    "\t\treturn &Error{Reason: ReasonTimestampOutOfTolerance}",
    "\t}",
    "\tkey, ok := secretKey(v.Secret)",
    "\tif !ok {",
    "\t\treturn &Error{Reason: ReasonInvalidSecret}",
    "\t}",
    "\tmac := hmac.New(sha256.New, key)",
    '\tmac.Write([]byte(id + "." + strconv.FormatInt(seconds, 10) + "."))',
    "\tmac.Write(payload)",
    "\texpected := mac.Sum(nil)",
    "\tcandidates := 0",
    '\tfor _, entry := range strings.Split(signatures, " ") {',
    "\t\tif candidates == maxSignatureCandidates {",
    "\t\t\tbreak",
    "\t\t}",
    '\t\tversion, rest, _ := strings.Cut(entry, ",")',
    '\t\tsignature, _, _ := strings.Cut(rest, ",")',
    '\t\tif version != "v1" || signature == "" {',
    "\t\t\tcontinue",
    "\t\t}",
    "\t\tcandidates++",
    "\t\tdecoded, ok := decodeBase64(signature)",
    "\t\tif ok && hmac.Equal(decoded, expected) {",
    "\t\t\treturn nil",
    "\t\t}",
    "\t}",
    "\treturn &Error{Reason: ReasonInvalidSignature}",
    "}",
    "",
    "func (v Verifier) isFresh(seconds int64) bool {",
    "\ttolerance := v.Tolerance",
    "\tif tolerance == 0 {",
    "\t\ttolerance = DefaultTolerance",
    "\t}",
    "\tskew := int64(tolerance / time.Second)",
    "\tnow := time.Now().Unix()",
    "\treturn seconds >= now-skew && seconds <= now+skew",
    "}",
    "",
    "// Reason is why a webhook was rejected, as the codes @typedhook/verify uses.",
    "type Reason string",
    "",
    "const (",
    '\tReasonMissingHeaders          Reason = "missing_headers"',
    '\tReasonInvalidID               Reason = "invalid_id"',
    '\tReasonInvalidTimestamp        Reason = "invalid_timestamp"',
    '\tReasonTimestampOutOfTolerance Reason = "timestamp_out_of_tolerance"',
    '\tReasonInvalidSignature        Reason = "invalid_signature"',
    '\tReasonInvalidSecret           Reason = "invalid_secret"',
    '\tReasonInvalidJSON             Reason = "invalid_json"',
    ")",
    "",
    "// Error is a rejected webhook; read its Reason with errors.As.",
    "type Error struct {",
    "\tReason Reason",
    "\t// Err is the decoding error behind ReasonInvalidJSON.",
    "\tErr error",
    "}",
    "",
    "func (e *Error) Error() string {",
    "\tif e.Err == nil {",
    `\t\treturn "${pkg}: " + string(e.Reason)`,
    "\t}",
    `\treturn "${pkg}: " + string(e.Reason) + ": " + e.Err.Error()`,
    "}",
    "",
    "func (e *Error) Unwrap() error {",
    "\treturn e.Err",
    "}",
    "",
    "// An empty webhook-* header doesn't fall back to svix-*, as in @typedhook/verify.",
    "func headerValue(header http.Header, name string) string {",
    '\tif values := header.Values("Webhook-" + name); len(values) > 0 {',
    "\t\treturn values[0]",
    "\t}",
    '\treturn header.Get("Svix-" + name)',
    "}",
    "",
    '// A "whsec_" secret that isn\'t base64 is invalid, never the literal string: that key would be guessable.',
    "func secretKey(secret string) ([]byte, bool) {",
    '\tencoded, isEncoded := strings.CutPrefix(secret, "whsec_")',
    "\tif !isEncoded {",
    '\t\treturn []byte(secret), secret != ""',
    "\t}",
    "\tkey, ok := decodeBase64(encoded)",
    "\treturn key, ok && len(key) > 0",
    "}",
    "",
    "// StdEncoding skips \\r and \\n, which @typedhook/verify rejects.",
    "func decodeBase64(text string) ([]byte, bool) {",
    '\tif strings.ContainsAny(text, "\\r\\n") {',
    "\t\treturn nil, false",
    "\t}",
    "\tdecoded, err := base64.StdEncoding.DecodeString(text)",
    "\treturn decoded, err == nil",
    "}",
  ].join("\n");
}
