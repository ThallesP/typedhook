import { componentName } from "./component-ref";
import { isRecord } from "./is-record";

export type RegistryEvent = {
  /** The key under `webhooks`. */
  name: string;
  description?: string;
  /** JSON Schema of the whole request body. */
  payload: unknown;
};

/** What every generator and the diff read out of a registry document. */
export type RegistryModel = {
  /** Sorted by name. */
  events: RegistryEvent[];
  /** `components.schemas`, which payloads `$ref` into. */
  schemas: Record<string, unknown>;
  /**
   * The payload property whose value names the event, like `event` in the
   * envelope @typedhook/sdk sends or `type` in Stripe's. Null when the events
   * don't all carry one (GitHub names them in a header instead).
   */
  discriminator: Discriminator | null;
};

export type Discriminator = {
  property: string;
  /** Event name → the property's value in its payloads. */
  values: Record<string, string>;
};

export function readRegistryDocument(label: string, document: unknown): RegistryModel {
  if (!isRecord(document) || !isRecord(document.webhooks)) {
    throw new Error(`${label}: the document has no webhooks object`);
  }
  const { webhooks } = document;
  const schemas =
    isRecord(document.components) && isRecord(document.components.schemas)
      ? document.components.schemas
      : {};
  const events = Object.keys(webhooks)
    .sort()
    .map((name) => readEvent(name, webhooks[name]));
  return { events, schemas, discriminator: findDiscriminator(events, schemas) };
}

function readEvent(name: string, webhook: unknown): RegistryEvent {
  const operation = isRecord(webhook) ? webhook.post : undefined;
  const payload = getPath(operation, ["requestBody", "content", "application/json", "schema"]);
  if (payload === undefined) throw new Error(`webhook "${name}" has no application/json request body`);
  const description = [
    getPath(operation, ["summary"]),
    getPath(operation, ["description"]),
    getPath(payload, ["description"]),
  ].find((text) => typeof text === "string" && text !== "");
  const event: RegistryEvent = { name, payload };
  if (typeof description === "string") event.description = description;
  return event;
}

/**
 * Prefers a property whose value is the event's own name, then any property
 * with a distinct string const in every payload.
 */
function findDiscriminator(
  events: RegistryEvent[],
  schemas: Record<string, unknown>,
): Discriminator | null {
  const [first, ...rest] = events.map((event) => stringConsts(event.payload, schemas));
  if (!first) return null;
  const candidates = [...first.keys()].flatMap((property) => {
    const values = [first, ...rest].map((consts) => consts.get(property));
    return values.every((value) => value !== undefined) ? [{ property, values }] : [];
  });
  const chosen =
    candidates.find(({ values }) => values.every((value, index) => value === events[index].name)) ??
    candidates.find(({ values }) => new Set(values).size === values.length);
  if (!chosen) return null;
  return {
    property: chosen.property,
    values: Object.fromEntries(events.map((event, index) => [event.name, chosen.values[index]])),
  };
}

/** Properties pinned to one string, looking through a top-level `$ref` and `allOf`. */
function stringConsts(schema: unknown, schemas: Record<string, unknown>): Map<string, string> {
  const consts = new Map<string, string>();
  const seen = new Set<unknown>();
  function visit(node: unknown): void {
    if (!isRecord(node) || seen.has(node)) return;
    seen.add(node);
    if (typeof node.$ref === "string") {
      const key = componentName(node.$ref);
      if (key !== null && Object.hasOwn(schemas, key)) visit(schemas[key]);
      return;
    }
    if (Array.isArray(node.allOf)) node.allOf.forEach(visit);
    if (!isRecord(node.properties)) return;
    for (const [property, value] of Object.entries(node.properties)) {
      const pinned = pinnedString(value);
      if (pinned !== null) consts.set(property, pinned);
    }
  }
  visit(schema);
  return consts;
}

function pinnedString(schema: unknown): string | null {
  if (!isRecord(schema)) return null;
  if (typeof schema.const === "string") return schema.const;
  const { enum: values } = schema;
  if (Array.isArray(values) && values.length === 1 && typeof values[0] === "string") return values[0];
  return null;
}

/** What consumers match on: the discriminator's value when there is one, else the webhook name. */
export function eventKey(model: RegistryModel, event: RegistryEvent): string {
  return model.discriminator?.values[event.name] ?? event.name;
}

export function getPath(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}
