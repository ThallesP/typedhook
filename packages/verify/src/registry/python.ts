import { componentName } from "./component-ref";
import type { CodegenContext } from "./generate";
import { isRecord } from "./is-record";
import { MAX_OUTPUT_LENGTH, getDescription } from "./json-schema-to-ts";
import { eventKey } from "./model";
import { PYTHON_KEYWORDS, pascalCase, typeName, uniqueNames } from "./names";

/** A Python type expression, written two ways. */
type Rendered = {
  /** For annotations, which `from __future__ import annotations` never evaluates. */
  text: string;
  /** For expressions evaluated at import, where generated names are quoted forward references. */
  runtime: string;
  /** The `typing` names it uses. */
  imports: ReadonlySet<string>;
  /** Bracket nesting. */
  depth: number;
};

type Member = { kind: "literal"; value: string } | { kind: "none" } | { kind: "type"; rendered: Rendered };

// Kept as union members so nested unions flatten and literals merge into one
// Literal[...]. An empty list is never.
type PyType = Member[];

type Scope = {
  /** The name a TypedDict here would get, before uniqueness. */
  hint: string;
  /** A name claimed up front for this schema, used if it's an object. */
  claimed?: string;
  doc?: string | null;
};

type Emitter = {
  claim: (name: string) => string;
  refName: (ref: string) => string | undefined;
  /** Top-level definitions in output order. */
  definitions: string[];
  /** Names of the TypedDicts defined so far. */
  classes: Set<string>;
  imports: Set<string>;
  size: number;
};

// Python's parser gives up around 200 nested brackets; deeper types become Any.
const MAX_NESTING = 64;

// A Map, so `type: "constructor"` doesn't find Object.prototype members.
const primitiveTypes = new Map([
  ["string", "str"],
  ["integer", "int"],
  ["number", "float"],
  ["boolean", "bool"],
]);

// Everything the module imports, defines or calls, so no generated class shadows it.
const MODULE_NAMES = [
  "Any", "Dict", "List", "Literal", "Mapping", "NoReturn", "NotRequired", "Optional", "Tuple",
  "TypeAlias", "TypedDict", "Union", "cast", "annotations", "base64", "hashlib", "hmac", "json", "re",
  "sys", "time", "Exception", "RecursionError", "ValueError", "abs", "float", "int", "isinstance",
  "len", "str", "super", "VerifyFailure", "WebhookVerificationError", "verify", "_BASE64",
  "_MAX_SIGNATURE_CANDIDATES", "_TIMESTAMP", "_base64", "_has_signature", "_header", "_lookup",
  "_reject_constant", "_secret_key", "_timestamp", ...PYTHON_KEYWORDS,
];

// From typing_extensions before Python 3.11.
const VERSIONED_IMPORTS = new Set(["NotRequired", "TypeAlias"]);

const VERIFIER_IMPORTS = ["Literal", "Mapping", "NoReturn", "Optional", "Union", "cast"];

// Escaped wherever document text lands: controls (newlines, NUL), bidi and
// other format characters, lone surrogates, private use and line separators.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

const shortEscapes = new Map([
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
]);

const ANY = rendered("Any", ["Any"]);

const NONE = rendered("None");

// Black's: past it, the typing import and the event union go one name per line, as black writes them.
const LINE_LENGTH = 88;

/**
 * One TypedDict per object schema, an alias per other component, the
 * `<Name>Event` union of the payloads and `verify()`, which checks Standard
 * Webhooks signatures with the semantics of @typedhook/verify. Stdlib only,
 * plus typing_extensions before Python 3.11.
 */
export function pythonCode({ registry, name, model }: CodegenContext): string {
  const base = typeName(name);
  const eventName = `${base}Event`;
  const { claim } = uniqueNames([eventName, ...MODULE_NAMES]);
  // Payload classes claim first: they're what consumers import.
  const payloadNames = model.events.map((event) => claim(`${base}${pascalCase(event.name) || "Payload"}`));
  const aliases = new Map(
    Object.keys(model.schemas)
      .sort()
      .map((key) => [key, claim(`${base}${pascalCase(key) || "Schema"}`)]),
  );
  const emitter: Emitter = {
    claim,
    refName: (ref) => {
      const key = componentName(ref);
      return key === null ? undefined : aliases.get(key);
    },
    definitions: [],
    classes: new Set(),
    imports: new Set(VERIFIER_IMPORTS),
    size: 0,
  };

  const payloads = model.events.flatMap((event, index) => {
    const doc = event.description?.trim() || null;
    const scope = { hint: payloadNames[index], claimed: payloadNames[index], doc };
    return convert(event.payload, scope, emitter);
  });
  for (const [key, alias] of aliases) {
    const schema = model.schemas[key];
    const doc = getDescription(schema);
    const type = render(convert(schema, { hint: alias, claimed: alias, doc }, emitter));
    if (emitter.classes.has(alias)) continue;
    const lines = doc === null ? [] : [comment(doc, "")];
    lines.push(`${alias}: TypeAlias = ${type.runtime}`);
    define(emitter, lines.join("\n"), [...type.imports, "TypeAlias"]);
  }

  const union = render(payloads);
  const unionLine = `${eventName} = ${union.text}`;
  if (union.text === "NoReturn") {
    // verify() can't return NoReturn, and a TypedDict without keys reads as "no events" too.
    const doc = docstring(`${registry} has no events.`, "    ");
    define(emitter, `class ${eventName}(TypedDict):\n    ${doc}`, ["TypedDict"]);
  } else if (unionLine.length <= LINE_LENGTH || !union.text.startsWith("Union[")) {
    define(emitter, unionLine, union.imports);
  } else {
    const members = unionMembers(payloads).map((member) => `    ${member.text},`);
    define(emitter, [`${eventName} = Union[`, ...members, "]"].join("\n"), union.imports);
  }

  const [example] = model.events;
  const narrowing =
    model.discriminator === null || example === undefined
      ? ""
      : `\n\nNarrow it with event[${pyString(model.discriminator.property)}] == ${pyString(eventKey(model, example))}.`;
  return [
    "",
    docstring(`${registry} webhook types and a Standard Webhooks signature verifier.`, ""),
    "",
    ...importLines(emitter.imports),
    ...emitter.definitions.flatMap((definition) => ["", "", definition]),
    "",
    "",
    verifierCode(eventName, narrowing),
  ].join("\n");
}

function convert(schema: unknown, scope: Scope, emitter: Emitter): PyType {
  if (schema === true) return [{ kind: "type", rendered: ANY }];
  if (schema === false) return [];
  if (!isRecord(schema)) return [{ kind: "type", rendered: ANY }];
  if (typeof schema.$ref === "string") {
    const name = emitter.refName(schema.$ref);
    return [{ kind: "type", rendered: name === undefined ? ANY : named(name) }];
  }
  if (schema.const !== undefined) return valueType(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.flatMap(valueType);

  // Variants can't take the claimed name: there may be several.
  const variantScope = { hint: scope.hint };
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) return variants.flatMap((variant) => convert(variant, variantScope, emitter));
  if (Array.isArray(schema.allOf)) return allOfType(schema, scope, emitter);

  const { type } = schema;
  // Deduped: each entry converts the whole schema again, so repeats nest exponentially.
  if (Array.isArray(type)) {
    return [...new Set(type)].flatMap((each) => convert({ ...schema, type: each }, variantScope, emitter));
  }
  if (type === "object") return objectType(schema, scope, emitter);
  if (type === "array") return arrayType(schema, scope, emitter);
  if (type === "null") return [{ kind: "none" }];
  if (typeof type !== "string") return [{ kind: "type", rendered: ANY }];
  const primitive = primitiveTypes.get(type);
  return [{ kind: "type", rendered: primitive === undefined ? ANY : rendered(primitive) }];
}

/** Literal for str, int, bool and None values; the value's base type otherwise. */
function valueType(value: unknown): PyType {
  if (value === null) return [{ kind: "none" }];
  if (typeof value === "string") return [{ kind: "literal", value: checked(pyString(value)) }];
  if (typeof value === "boolean") return [{ kind: "literal", value: value ? "True" : "False" }];
  if (typeof value === "number") {
    // Integers past 2^53 were already rounded by JSON.parse, so they'd be wrong literals.
    if (Number.isSafeInteger(value)) return [{ kind: "literal", value: String(value) }];
    return [{ kind: "type", rendered: rendered("float") }];
  }
  if (Array.isArray(value)) return [{ kind: "type", rendered: generic("List", [ANY]) }];
  return [{ kind: "type", rendered: generic("Dict", [rendered("str"), ANY]) }];
}

function objectType(schema: Record<string, unknown>, scope: Scope, emitter: Emitter): PyType {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const extra = schema.additionalProperties;
  const keys = Object.keys(properties);

  if (keys.length === 0 && (extra === undefined || extra === true)) {
    return [{ kind: "type", rendered: generic("Dict", [rendered("str"), ANY]) }];
  }
  if (keys.length === 0 && extra !== false) {
    const value = render(convert(extra, { hint: `${scope.hint}Value` }, emitter));
    return [{ kind: "type", rendered: generic("Dict", [rendered("str"), value]) }];
  }

  // A TypedDict can't type extra keys (PEP 728 isn't in typing yet), so they're left out.
  const name = scope.claimed ?? emitter.claim(scope.hint);
  emitter.classes.add(name);
  // Reserved now so the class comes before the classes its fields create.
  const slot = emitter.definitions.push("") - 1;
  const fields = keys.map((key) => ({
    key,
    isRequired: required.includes(key),
    type: render(convert(properties[key], { hint: `${name}${pascalCase(key) || "Property"}` }, emitter)),
    description: getDescription(properties[key]),
  }));
  const imports = new Set(["TypedDict", ...fields.flatMap((field) => [...field.type.imports])]);
  if (fields.some((field) => !field.isRequired)) imports.add("NotRequired");
  const doc = scope.doc ?? null;
  const code = fields.every((field) => isIdentifier(field.key))
    ? classTypedDict(name, fields, doc)
    : functionalTypedDict(name, fields, doc);
  define(emitter, code, imports, slot);
  return [{ kind: "type", rendered: named(name) }];
}

type Field = { key: string; isRequired: boolean; type: Rendered; description: string | null };

function classTypedDict(name: string, fields: Field[], doc: string | null): string {
  const lines = [`class ${name}(TypedDict):`];
  if (doc !== null) lines.push(`    ${docstring(doc, "    ")}`);
  if (doc !== null && fields.length > 0) lines.push("");
  if (doc === null && fields.length === 0) lines.push("    pass");
  for (const field of fields) {
    if (field.description !== null) lines.push(comment(field.description, "    "));
    lines.push(`    ${field.key}: ${fieldType(field, field.type.text)}`);
  }
  return lines.join("\n");
}

/** For keys that aren't identifiers. Its values are evaluated at import, so they use runtime text. */
function functionalTypedDict(name: string, fields: Field[], doc: string | null): string {
  const lines = doc === null ? [] : [comment(doc, "")];
  lines.push(`${name} = TypedDict(`, `    "${name}",`, "    {");
  for (const field of fields) {
    if (field.description !== null) lines.push(comment(field.description, "        "));
    lines.push(`        ${pyString(field.key)}: ${fieldType(field, field.type.runtime)},`);
  }
  lines.push("    },", ")");
  return lines.join("\n");
}

function fieldType(field: Field, text: string): string {
  return field.isRequired ? text : `NotRequired[${text}]`;
}

/**
 * json.loads gives lists, never tuples, so a JSON tuple is a list of its
 * element types: a Tuple annotation would let consumers hash or compare it
 * as a tuple and fail at runtime.
 */
function arrayType(schema: Record<string, unknown>, scope: Scope, emitter: Emitter): PyType {
  const { prefixItems, items, maxItems } = schema;
  const itemScope = { hint: `${scope.hint}Item` };
  if (!Array.isArray(prefixItems)) {
    const item = items === undefined ? ANY : render(convert(items, itemScope, emitter));
    return [{ kind: "type", rendered: generic("List", [item]) }];
  }

  const max = typeof maxItems === "number" ? maxItems : Number.POSITIVE_INFINITY;
  // A list of the element types needs each distinct one once; converting a
  // shared member at every level would double the work per level.
  const distinct = [...new Set(prefixItems.slice(0, Math.max(0, max)))];
  const members = distinct.map((item) => convert(item, itemScope, emitter));
  const isClosed = items === undefined || items === false || max <= prefixItems.length;
  const rest = isClosed ? [] : convert(items, itemScope, emitter);
  const elements = [...members.flat(), ...rest];
  return [{ kind: "type", rendered: generic("List", [elements.length === 0 ? ANY : render(elements)]) }];
}

/**
 * Merges parts that are all plain objects into one TypedDict. Anything else
 * (refs, unions, primitives) becomes Any. The schema's own properties count as
 * a part, since discriminators can sit next to an allOf.
 */
function allOfType(schema: Record<string, unknown>, scope: Scope, emitter: Emitter): PyType {
  const { allOf, ...own } = schema;
  const parts = Array.isArray(allOf) ? allOf : [];
  const objects = [...(isRecord(own.properties) ? [own] : []), ...parts].filter((part) => part !== true);
  if (!objects.every(isMergeable) || !objects.some((part) => part.type === "object" || isRecord(part.properties))) {
    return [{ kind: "type", rendered: ANY }];
  }
  // A Map, so a `__proto__` property stays a property.
  const properties = new Map<string, unknown[]>();
  const required = new Set<unknown>();
  for (const part of objects) {
    for (const [key, property] of Object.entries(isRecord(part.properties) ? part.properties : {})) {
      properties.set(key, [...(properties.get(key) ?? []), property]);
    }
    if (Array.isArray(part.required)) part.required.forEach((key) => required.add(key));
  }
  const merged = {
    type: "object",
    properties: Object.fromEntries(
      [...properties].map(([key, schemas]) => [key, schemas.length === 1 ? schemas[0] : { allOf: schemas }]),
    ),
    required: [...required],
    additionalProperties: objects.every((part) => part.additionalProperties === false) ? false : undefined,
  };
  return objectType(merged, scope, emitter);
}

function isMergeable(part: unknown): part is Record<string, unknown> {
  if (!isRecord(part) || (part.type !== undefined && part.type !== "object")) return false;
  return ["$ref", "anyOf", "oneOf", "allOf", "const", "enum"].every((keyword) => part[keyword] === undefined);
}

function render(type: PyType): Rendered {
  const members = unionMembers(type);
  const [first, second] = members;
  if (first === undefined) return rendered("NoReturn", ["NoReturn"]);
  if (second === undefined) return first;
  if (second === NONE && members.length === 2) return generic("Optional", [first]);
  return generic("Union", members);
}

/** Deduped, with literals merged into one Literal[...] and None last. Just Any when a member is. */
function unionMembers(type: PyType): Rendered[] {
  // Keyed by text; "" (no type renders empty) holds the Literal's place, where the first literal was.
  const parts = new Map<string, Rendered | null>();
  const literals = new Set<string>();
  let hasNone = false;
  for (const member of type) {
    if (member.kind === "none") {
      hasNone = true;
    } else if (member.kind === "literal") {
      if (!parts.has("")) parts.set("", null);
      literals.add(member.value);
    } else {
      if (member.rendered.text === "Any") return [ANY];
      parts.set(member.rendered.text, member.rendered);
    }
  }
  const members = [...parts.values()].map(
    (part) => part ?? rendered(checked(`Literal[${[...literals].join(", ")}]`), ["Literal"]),
  );
  return hasNone ? [...members, NONE] : members;
}

function generic(head: string, args: Rendered[]): Rendered {
  const depth = 1 + Math.max(0, ...args.map((arg) => arg.depth));
  if (depth > MAX_NESTING) return ANY;
  return {
    text: checked(`${head}[${args.map((arg) => arg.text).join(", ")}]`),
    runtime: checked(`${head}[${args.map((arg) => arg.runtime).join(", ")}]`),
    imports: new Set([head, ...args.flatMap((arg) => [...arg.imports])]),
    depth,
  };
}

function rendered(text: string, imports: string[] = []): Rendered {
  return { text, runtime: text, imports: new Set(imports), depth: 0 };
}

/** A generated name, quoted where it's evaluated at import and may not be defined yet. */
function named(name: string): Rendered {
  return { text: name, runtime: `"${name}"`, imports: new Set(), depth: 0 };
}

// Every type is built through here, so an oversized one fails as soon as it exists.
function checked(text: string): string {
  assertSize(text.length);
  return text;
}

function assertSize(length: number): void {
  if (length <= MAX_OUTPUT_LENGTH) return;
  const limit = MAX_OUTPUT_LENGTH.toLocaleString("en-US");
  throw new Error(`a schema generates over ${limit} characters of types`);
}

function define(emitter: Emitter, code: string, imports: Iterable<string>, slot?: number): void {
  // Each definition is under the cap, but thousands of them add up.
  emitter.size += code.length;
  assertSize(emitter.size);
  for (const name of imports) emitter.imports.add(name);
  if (slot === undefined) emitter.definitions.push(code);
  else emitter.definitions[slot] = code;
}

/**
 * ASCII only: Python NFKC-normalizes identifiers, so `ﬁeld` would declare
 * `field`. Leading `__` gets name-mangled in a class body.
 */
function isIdentifier(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !PYTHON_KEYWORDS.has(key) && !key.startsWith("__");
}

// Backslashes and quotes first: the escapes UNSAFE adds must stay single.
function pyString(text: string): string {
  return `"${text.replace(/[\\"]/g, "\\$&").replace(UNSAFE, escapeCodePoint)}"`;
}

/**
 * A triple-quoted docstring at `pad`. Backslashes are doubled and a quote is
 * escaped when another quote or the closing delimiter follows it, so the text
 * can't contain `"""`.
 */
function docstring(text: string, pad: string): string {
  const lines = text.split(/\r\n|\r|\n/).map((line) =>
    line
      .trimEnd()
      .replace(/\\/g, "\\\\")
      .replace(/"(?="|$)/g, '\\"')
      .replace(UNSAFE, escapeCodePoint),
  );
  if (lines.length === 1) return `"""${lines[0]}"""`;
  const rest = lines.slice(1).map((line) => (line ? `${pad}${line}` : ""));
  return [`"""${lines[0]}`, ...rest, `${pad}"""`].join("\n");
}

/**
 * `#:` comments (Sphinx's attribute docs) rather than `#`, so a description
 * can't become a `# type: ignore` or a file-wide `# mypy: ignore-errors`.
 */
function comment(text: string, pad: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const escaped = line.trimEnd().replace(UNSAFE, escapeCodePoint);
      return escaped.trim() ? `${pad}#: ${escaped}` : `${pad}#:`;
    })
    .join("\n");
}

function escapeCodePoint(char: string): string {
  const short = shortEscapes.get(char);
  if (short !== undefined) return short;
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0xff) return `\\x${code.toString(16).padStart(2, "0")}`;
  if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, "0")}`;
  return `\\U${code.toString(16).padStart(8, "0")}`;
}

function importLines(imports: Set<string>): string[] {
  const typing = [...imports].filter((name) => !VERSIONED_IMPORTS.has(name)).sort();
  const versioned = [...imports].filter((name) => VERSIONED_IMPORTS.has(name)).sort();
  const modules = ["base64", "hashlib", "hmac", "json", "re", ...(versioned.length > 0 ? ["sys"] : []), "time"];
  const fromTyping = `from typing import ${typing.join(", ")}`;
  const lines = [
    "from __future__ import annotations",
    "",
    ...modules.map((module) => `import ${module}`),
    ...(fromTyping.length <= LINE_LENGTH
      ? [fromTyping]
      : ["from typing import (", ...typing.map((name) => `    ${name},`), ")"]),
  ];
  if (versioned.length === 0) return lines;
  return [
    ...lines,
    "",
    "if sys.version_info >= (3, 11):",
    `    from typing import ${versioned.join(", ")}`,
    "else:",
    `    from typing_extensions import ${versioned.join(", ")}`,
  ];
}

function verifierCode(eventName: string, narrowing: string): string {
  const verifyDoc = docstring(
    `Verifies a Standard Webhooks signature and returns the parsed payload.

payload must be the raw request body: re-serialized JSON won't match the
signature. The signature proves who sent the payload, not its shape, so it
isn't validated against the types. Raises WebhookVerificationError.${narrowing}`,
    "    ",
  );
  return `VerifyFailure = Literal[
    "missing_headers",
    "invalid_id",
    "invalid_timestamp",
    "timestamp_out_of_tolerance",
    "invalid_signature",
    "invalid_secret",
    "invalid_json",
]

# Cap on signatures compared per request: the header is attacker-controlled.
_MAX_SIGNATURE_CANDIDATES = 8
_BASE64 = re.compile(r"[A-Za-z0-9+/]*={0,2}")
_TIMESTAMP = re.compile(r"[+-]?(?:[0-9]+[.]?[0-9]*|[.][0-9]+)(?:[eE][+-]?[0-9]+)?")


class WebhookVerificationError(Exception):
    """Raised by verify(). reason says why."""

    def __init__(self, reason: VerifyFailure) -> None:
        super().__init__(reason)
        self.reason = reason


def verify(
    payload: Union[bytes, str],
    headers: Mapping[str, str],
    secret: str,
    *,
    tolerance_sec: int = 300,
) -> ${eventName}:
    ${verifyDoc}
    key = _secret_key(secret)
    # Written so NaN fails too: it would accept every replay.
    if not tolerance_sec >= 0:
        raise ValueError(f"tolerance_sec must be >= 0, got {tolerance_sec}")
    webhook_id = _header(headers, "id")
    timestamp_header = _header(headers, "timestamp")
    signature_header = _header(headers, "signature")
    if not webhook_id or not timestamp_header or not signature_header:
        raise WebhookVerificationError("missing_headers")
    # A "." in the id makes "{id}.{timestamp}.{payload}" ambiguous: shifting the
    # boundaries yields another triple with the same valid signature.
    if "." in webhook_id:
        raise WebhookVerificationError("invalid_id")
    timestamp = _timestamp(timestamp_header)
    if timestamp is None:
        raise WebhookVerificationError("invalid_timestamp")
    if abs(int(time.time()) - timestamp) > tolerance_sec:
        raise WebhookVerificationError("timestamp_out_of_tolerance")
    body = payload.encode() if isinstance(payload, str) else payload
    signed = f"{webhook_id}.{timestamp}.".encode() + body
    expected = hmac.new(key, signed, hashlib.sha256).digest()
    if not _has_signature(expected, signature_header):
        raise WebhookVerificationError("invalid_signature")
    if isinstance(payload, bytes):
        payload = payload.decode("utf-8-sig", "replace")
    try:
        value = json.loads(payload, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        raise WebhookVerificationError("invalid_json") from None
    return cast(${eventName}, value)


def _secret_key(secret: str) -> bytes:
    # A "whsec_" secret that isn't base64 must not fall back to the literal
    # string: that key would be publicly guessable.
    if secret.startswith("whsec_"):
        key = _base64(secret.removeprefix("whsec_"))
    else:
        key = secret.encode()
    if not key:
        raise WebhookVerificationError("invalid_secret")
    return key


def _header(headers: Mapping[str, str], name: str) -> Optional[str]:
    for prefix in ("webhook-", "svix-"):
        value = _lookup(headers, prefix + name)
        if value is not None:
            return value
    return None


def _lookup(headers: Mapping[str, str], name: str) -> Optional[str]:
    value = headers.get(name)
    if value is not None:
        return value
    # Plain dicts keep whatever casing they were built with. isinstance skips
    # werkzeug's Headers, which iterates (key, value) pairs.
    for key in headers:
        if isinstance(key, str) and key.lower() == name:
            return headers[key]
    return None


def _timestamp(text: str) -> Optional[int]:
    # Decimal text read the way JavaScript's Number() reads it, so a sender's
    # "1.7e9" is signed as "1700000000" by both verifiers.
    text = text.strip()
    if not _TIMESTAMP.fullmatch(text):
        return None
    value = float(text)
    return int(value) if value.is_integer() else None


def _has_signature(expected: bytes, signature_header: str) -> bool:
    candidates = 0
    for part in signature_header.split(" "):
        if candidates >= _MAX_SIGNATURE_CANDIDATES:
            return False
        version, _, rest = part.partition(",")
        signature, _, _ = rest.partition(",")
        if version != "v1" or not signature:
            continue
        candidates += 1
        signature_bytes = _base64(signature)
        if signature_bytes is None:
            continue
        if hmac.compare_digest(expected, signature_bytes):
            return True
    return False


def _base64(text: str) -> Optional[bytes]:
    if len(text) % 4 or not _BASE64.fullmatch(text):
        return None
    return base64.b64decode(text)


def _reject_constant(name: str) -> NoReturn:
    # json.loads accepts NaN and Infinity, which aren't JSON.
    raise ValueError(name)
`;
}
