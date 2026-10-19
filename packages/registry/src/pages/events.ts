import {
  type RegistryEvent,
  type RegistryModel,
  componentName,
  eventKey,
  jsonSchemaToTs,
  typeName,
} from "@typedhook/verify/registry";
import { isRecord } from "../is-record";
import { highlight } from "./highlight";
import { type Html, html } from "./html";
import { tabs } from "./tabs";

type Example = { label: string; value: unknown };

/** Section ids on the registry page that an event's anchor must not take. */
export const SECTION_IDS = ["install", "events", "code", "versions"];

/** One id per event, made of `[a-z0-9._-]` only so it's safe in a `#` link, and unique on the page. */
export function eventAnchors(events: RegistryEvent[]): string[] {
  const taken = new Set(SECTION_IDS);
  return events.map((event) => {
    const slug = event.name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const base = slug === "" ? "event" : slug;
    let anchor = base;
    for (let suffix = 2; taken.has(anchor); suffix++) anchor = `${base}-${suffix}`;
    taken.add(anchor);
    return anchor;
  });
}

export function eventList(model: RegistryModel, registryName: string, anchors: string[]): Html {
  return html`<div class="events">${model.events.map((event, index) =>
    eventItem(model, registryName, event, anchors[index], `event-${index}`),
  )}</div>`;
}

function eventItem(
  model: RegistryModel,
  registryName: string,
  event: RegistryEvent,
  anchor: string,
  group: string,
): Html {
  const key = eventKey(model, event);
  const typeTab = {
    label: "Payload type",
    panel: codePanel(highlight(payloadType(event.payload, model.schemas, registryName), "typescript")),
  };
  const example = exampleOf(event.payload, model.schemas);
  const items =
    example === null
      ? [typeTab]
      : [typeTab, { label: example.label, panel: codePanel(highlight(JSON.stringify(example.value, null, 2), "json")) }];
  const keyLine =
    model.discriminator !== null && key !== event.name
      ? html`<p class="event-key">${model.discriminator.property}: ${JSON.stringify(key)}</p>`
      : null;

  return html`<article class="event" id="${anchor}">
<h3><a href="#${anchor}">${event.name}<span class="hash" aria-hidden="true">#</span></a></h3>
${keyLine}
${event.description === undefined ? null : html`<p class="event-description">${event.description}</p>`}
${tabs(group, items)}
</article>`;
}

function codePanel(code: Html): Html {
  return html`<div class="scroll"><pre><code>${code}</code></pre></div>`;
}

/**
 * The payload's type, then an alias for each component schema it reaches,
 * named the way the generated TypeScript file names them.
 */
function payloadType(payload: unknown, schemas: Record<string, unknown>, registryName: string): string {
  const aliasName = (key: string) => typeName(`${registryName}.${key}`);
  const refName = (ref: string) => {
    const key = componentName(ref);
    return key !== null && Object.hasOwn(schemas, key) ? aliasName(key) : undefined;
  };
  try {
    const aliases = referencedComponents(payload, schemas).map(
      (key) => `type ${aliasName(key)} = ${jsonSchemaToTs(schemas[key], { refName })};`,
    );
    return [jsonSchemaToTs(payload, { refName }), ...aliases].join("\n\n");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return `// ${reason.replaceAll("\n", " ")}`;
  }
}

/** Component schemas the payload reaches through `$ref`, sorted like the generated file sorts them. */
function referencedComponents(payload: unknown, schemas: Record<string, unknown>): string[] {
  const found = new Set<string>();
  // A stack and loops instead of spreads: a hostile schema can hold arrays too long to spread.
  const pending: unknown[] = [payload];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null) continue;
    for (const child of Object.values(node)) pending.push(child);
    if (!isRecord(node) || typeof node.$ref !== "string") continue;
    const key = componentName(node.$ref);
    if (key === null || !Object.hasOwn(schemas, key) || found.has(key)) continue;
    found.add(key);
    pending.push(schemas[key]);
  }
  return [...found].sort();
}

/**
 * The payload schema's first example. For typedhook's `{ event, subject, data }`
 * envelope, schema libraries put examples on the event's own schema, so it
 * falls back to the first example of `data`.
 */
function exampleOf(payload: unknown, schemas: Record<string, unknown>): Example | null {
  const schema = resolveRef(payload, schemas);
  const [example] = examplesOf(schema);
  if (example !== undefined) return { label: "Example", value: example };
  const data = isRecord(schema) && isRecord(schema.properties) ? resolveRef(schema.properties.data, schemas) : null;
  const [dataExample] = examplesOf(data);
  if (dataExample !== undefined) return { label: "Example data", value: dataExample };
  return null;
}

function examplesOf(schema: unknown): unknown[] {
  if (!isRecord(schema) || !Array.isArray(schema.examples)) return [];
  return schema.examples;
}

function resolveRef(schema: unknown, schemas: Record<string, unknown>): unknown {
  if (!isRecord(schema) || typeof schema.$ref !== "string") return schema;
  const key = componentName(schema.$ref);
  return key !== null && Object.hasOwn(schemas, key) ? schemas[key] : schema;
}
