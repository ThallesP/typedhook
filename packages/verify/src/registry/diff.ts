import { componentName } from "./component-ref";
import { canonicalJson } from "./hash";
import { isRecord } from "./is-record";
import { type RegistryModel, readRegistryDocument } from "./model";
import { isStrictSemver } from "./registry-client";

export type Bump = "major" | "minor" | "patch";

export type SchemaChange = {
  bump: Bump;
  /** The webhook name. */
  event: string;
  /** Where in the payload, like `data.lines[].sku`; empty for the event itself. */
  path: string;
  message: string;
};

export type DocumentDiff = {
  /** The smallest release that covers every change; null when nothing changed. */
  bump: Bump | null;
  changes: SchemaChange[];
};

// Shapes keep only what decides compatibility; descriptions and validation
// keywords don't change what a consumer's code can rely on.
type PrimitiveKind = "string" | "number" | "integer" | "boolean" | "null";

type Shape =
  | { kind: "any" }
  | { kind: PrimitiveKind }
  | { kind: "literal"; value: string }
  | { kind: "array"; items: unknown }
  | { kind: "object"; properties: Map<string, { schema: unknown; isRequired: boolean }> };

type Side = { schemas: Record<string, unknown> };

const BUMP_RANK: Record<Bump, number> = { patch: 1, minor: 2, major: 3 };

const PRIMITIVES = new Set<string>(["string", "number", "integer", "boolean", "null"]);

/**
 * How `after` changes things for a consumer written against `before`. A
 * webhook flows from sender to consumer, so anything the consumer could rely
 * on that's gone (an event, a field, a guaranteed field, a type) is major;
 * anything new (an event, a field, an enum value) is minor; edits that don't
 * change the types, like descriptions and examples, are a patch.
 */
export function diffDocuments(before: unknown, after: unknown): DocumentDiff {
  const old = readRegistryDocument("previous version", before);
  const next = readRegistryDocument("new version", after);
  const changes: SchemaChange[] = [];
  const oldEvents = new Map(old.events.map((event) => [event.name, event]));
  const nextEvents = new Map(next.events.map((event) => [event.name, event]));
  for (const event of old.events) {
    if (!nextEvents.has(event.name)) changes.push({ bump: "major", event: event.name, path: "", message: "removed" });
  }
  for (const event of next.events) {
    const previous = oldEvents.get(event.name);
    if (previous === undefined) {
      changes.push({ bump: "minor", event: event.name, path: "", message: "added" });
      continue;
    }
    const compare = comparer(old, next, event.name, changes);
    compare(previous.payload, event.payload, "");
  }
  if (changes.length === 0 && canonicalJson(withoutInfo(before)) !== canonicalJson(withoutInfo(after))) {
    changes.push({ bump: "patch", event: "", path: "", message: "descriptions or examples changed" });
  }
  return { bump: highestBump(changes), changes };
}

/** `previous` moved by `bump`; a prerelease is released as its own version. */
export function nextVersion(previous: string, bump: Bump): string {
  if (!isStrictSemver(previous)) throw new Error(`invalid version ${JSON.stringify(previous)}`);
  const [core = "", prerelease] = previous.split(/-(.*)/s);
  if (prerelease !== undefined) return core;
  const [major, minor, patch] = core.split(".").map(Number);
  const next: Record<Bump, string> = {
    major: `${major + 1}.0.0`,
    minor: `${major}.${minor + 1}.0`,
    patch: `${major}.${minor}.${patch + 1}`,
  };
  return next[bump];
}

/** The bump `version` makes over `previous`, or null when it doesn't move forward. */
export function versionBump(previous: string, version: string): Bump | null {
  const [a, b] = [previous, version].map((text) => text.split("-")[0].split(".").map(Number));
  if (b[0] !== a[0]) return b[0] > a[0] ? "major" : null;
  if (b[1] !== a[1]) return b[1] > a[1] ? "minor" : null;
  if (b[2] !== a[2]) return b[2] > a[2] ? "patch" : null;
  return null;
}

export function isBumpEnough(made: Bump | null, needed: Bump | null): boolean {
  if (needed === null) return true;
  return made !== null && BUMP_RANK[made] >= BUMP_RANK[needed];
}

function highestBump(changes: SchemaChange[]): Bump | null {
  let highest: Bump | null = null;
  for (const { bump } of changes) if (highest === null || BUMP_RANK[bump] > BUMP_RANK[highest]) highest = bump;
  return highest;
}

function withoutInfo(document: unknown): unknown {
  if (!isRecord(document)) return document;
  const { info, ...rest } = document;
  return rest;
}

function comparer(old: RegistryModel, next: RegistryModel, event: string, changes: SchemaChange[]) {
  // Recursive schemas would compare forever; a pair already being compared counts as equal.
  const comparing = new Set<string>();
  function change(bump: Bump, path: string, message: string): void {
    changes.push({ bump, event, path, message });
  }

  function compare(before: unknown, after: unknown, path: string): void {
    const pairKey = `${refKey(before)}|${refKey(after)}`;
    if (comparing.has(pairKey)) return;
    if (pairKey !== "|") comparing.add(pairKey);
    compareShapes(shapes(old, before), shapes(next, after), path);
    comparing.delete(pairKey);
  }

  function compareShapes(oldMembers: Shape[], newMembers: Shape[], path: string): void {
    if (oldMembers.some((shape) => shape.kind === "any")) return;
    if (newMembers.some((shape) => shape.kind === "any")) {
      change("major", path, "is no longer typed");
      return;
    }
    const matched = new Set<Shape>();
    for (const shape of newMembers) {
      const counterpart = oldMembers.find((candidate) => accepts(candidate, shape));
      if (counterpart === undefined) {
        change(...widened(shape, oldMembers, path));
        continue;
      }
      matched.add(counterpart);
      if (counterpart.kind === "object" && shape.kind === "object") compareObjects(counterpart, shape, path);
      if (counterpart.kind === "array" && shape.kind === "array") compare(counterpart.items, shape.items, `${path}[]`);
    }
    for (const shape of oldMembers) {
      if (!matched.has(shape)) change("minor", path, `can no longer be ${describe(shape)}`);
    }
  }

  function compareObjects(
    before: Extract<Shape, { kind: "object" }>,
    after: Extract<Shape, { kind: "object" }>,
    path: string,
  ): void {
    for (const [key, property] of before.properties) {
      const at = path === "" ? key : `${path}.${key}`;
      const counterpart = after.properties.get(key);
      if (counterpart === undefined) {
        change("major", at, "was removed");
        continue;
      }
      if (property.isRequired && !counterpart.isRequired) change("major", at, "is now optional");
      if (!property.isRequired && counterpart.isRequired) change("minor", at, "is now always sent");
      compare(property.schema, counterpart.schema, at);
    }
    for (const [key, property] of after.properties) {
      if (before.properties.has(key)) continue;
      const at = path === "" ? key : `${path}.${key}`;
      change("minor", at, property.isRequired ? "was added" : "was added (optional)");
    }
  }

  return compare;
}

/** Whether a consumer expecting `expected` handles every value of `actual` without code changes. */
function accepts(expected: Shape, actual: Shape): boolean {
  if (expected.kind === "literal") return actual.kind === "literal" && actual.value === expected.value;
  const kind = actual.kind === "literal" ? literalKind(actual.value) : actual.kind;
  if (expected.kind === "number") return kind === "number" || kind === "integer";
  return expected.kind === kind;
}

/** A new kind of value the consumer didn't expect. A new enum value is minor by convention, like Stripe and GitHub treat them. */
function widened(shape: Shape, oldMembers: Shape[], path: string): [Bump, string, string] {
  const isEnum = shape.kind === "literal" && oldMembers.some((member) => member.kind === "literal");
  if (isEnum) return ["minor", path, `has a new value ${describe(shape)}`];
  return ["major", path, `can now be ${describe(shape)}`];
}

function describe(shape: Shape): string {
  if (shape.kind === "literal") return shape.value;
  if (shape.kind === "integer") return "an integer";
  if (shape.kind === "array" || shape.kind === "object") return `an ${shape.kind}`;
  if (shape.kind === "null") return "null";
  return `a ${shape.kind}`;
}

function literalKind(json: string): string {
  const value: unknown = JSON.parse(json);
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function refKey(schema: unknown): string {
  return isRecord(schema) && typeof schema.$ref === "string" ? schema.$ref : "";
}

/** The union members a schema allows, following refs and flattening anyOf, oneOf and type arrays. */
function shapes(side: Side, schema: unknown, seen = new Set<string>()): Shape[] {
  if (schema === true || !isRecord(schema)) return [{ kind: "any" }];
  if (typeof schema.$ref === "string") {
    const key = componentName(schema.$ref);
    if (key === null || !Object.hasOwn(side.schemas, key) || seen.has(key)) return [{ kind: "any" }];
    return shapes(side, side.schemas[key], new Set([...seen, key]));
  }
  if (schema.const !== undefined) return [{ kind: "literal", value: JSON.stringify(schema.const) }];
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => ({ kind: "literal", value: JSON.stringify(value) }));
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) return variants.flatMap((variant) => shapes(side, variant, seen));
  if (Array.isArray(schema.allOf)) return mergeAllOf(side, schema.allOf, seen);
  const { type } = schema;
  if (Array.isArray(type)) return [...new Set(type)].flatMap((each) => shapes(side, { ...schema, type: each }, seen));
  if (type === "object") return [objectShape(schema)];
  if (type === "array") return [{ kind: "array", items: schema.items ?? true }];
  if (typeof type === "string" && isPrimitive(type)) return [{ kind: type }];
  return [{ kind: "any" }];
}

function isPrimitive(type: string): type is PrimitiveKind {
  return PRIMITIVES.has(type);
}

function objectShape(schema: Record<string, unknown>): Shape {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return {
    kind: "object",
    properties: new Map(
      Object.entries(properties).map(([key, property]) => [key, { schema: property, isRequired: required.includes(key) }]),
    ),
  };
}

/** allOf of objects merges into one object; anything else is compared loosely. */
function mergeAllOf(side: Side, parts: unknown[], seen: Set<string>): Shape[] {
  const members = parts.map((part) => shapes(side, part, seen));
  if (!members.every((shapesOfPart) => shapesOfPart.length === 1 && shapesOfPart[0]?.kind === "object")) {
    return [{ kind: "any" }];
  }
  const properties = new Map<string, { schema: unknown; isRequired: boolean }>();
  for (const [shape] of members) {
    if (shape?.kind !== "object") continue;
    for (const [key, property] of shape.properties) {
      const existing = properties.get(key);
      properties.set(key, { schema: property.schema, isRequired: property.isRequired || existing?.isRequired === true });
    }
  }
  return [{ kind: "object", properties }];
}
