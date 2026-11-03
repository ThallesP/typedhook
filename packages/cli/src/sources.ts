import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type OpenAPIDocument,
  type OpenAPIInfo,
  componentName,
  inferSchema,
  readRegistryDocument,
  schemasToOpenAPI,
  toOpenAPI,
} from "@typedhook/verify/registry";
import { createJiti } from "jiti";
import { parse as parseYaml } from "yaml";
import type { PublishConfig } from "./config";
import { isRecord } from "./is-record";

const SOURCE_KINDS = ["events", "openapi", "schemas", "examples"] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export type Source = { kind: SourceKind; path: string; exportName: string };

const STRUCTURED = new Set([".json", ".yaml", ".yml"]);

export const SOURCE_HELP = [
  "tell typedhook where your events are, with one of:",
  "  --events src/webhooks/events.ts  a module exporting zod, valibot or arktype schemas (`export const events = {...}`)",
  "  --openapi openapi.yaml           an OpenAPI 3.1 document with a webhooks section",
  "  --schemas events/                one JSON Schema file per event, named after it (invoice.paid.json)",
  "  --examples fixtures/webhooks/    example payloads, one file (or folder of files) per event",
].join("\n");

/** Title and description when the sender gave them; an OpenAPI source has its own to fall back on. */
export type DocumentInfo = { name: string; version: string; title?: string; description?: string };

export function sourceOf(publish: PublishConfig): Source {
  const sources = SOURCE_KINDS.flatMap((kind) => {
    const path = publish[kind];
    return path === undefined ? [] : [{ kind, path, exportName: publish.export ?? "events" }];
  });
  const [source] = sources;
  if (source === undefined) throw new Error(SOURCE_HELP);
  if (sources.length > 1) throw new Error(`use one of --${sources.map(({ kind }) => kind).join(", --")}, not several`);
  return source;
}

/** The OpenAPI 3.1 document the registry stores, built from whatever the sender has. */
export async function buildDocument(source: Source, given: DocumentInfo, cwd: string): Promise<OpenAPIDocument> {
  const path = resolve(cwd, source.path);
  const info = openapiInfo(undefined, given);
  const builders: Record<SourceKind, () => Promise<OpenAPIDocument>> = {
    events: async () => toOpenAPI(await loadEvents(path, source.exportName), info),
    openapi: async () => fromOpenAPI(await readStructured(path), source.path, given),
    schemas: async () => schemasToOpenAPI(await readSchemas(path), info),
    examples: async () => schemasToOpenAPI(await readExamples(path), info),
  };
  const document = await builders[source.kind]();
  readRegistryDocument(source.path, document);
  return document;
}

/**
 * jiti rather than a plain import: sender code may be TypeScript with
 * extensionless imports or CJS, which Node's type stripping won't run.
 */
async function loadEvents(path: string, exportName: string): Promise<Record<string, unknown>> {
  const jiti = createJiti(pathToFileURL(path).href, { interopDefault: true });
  let module: unknown;
  try {
    module = await jiti.import(path);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`can't import ${path}: ${reason}`, { cause });
  }
  const events = isRecord(module) ? module[exportName] : undefined;
  if (!isRecord(events)) {
    throw new Error(`${path} has no "${exportName}" export holding an object of event schemas`);
  }
  return events;
}

/**
 * Keeps the webhooks and the component schemas they reach, so a company's
 * whole API description publishes as just its events.
 */
function fromOpenAPI(document: unknown, label: string, given: DocumentInfo): OpenAPIDocument {
  // The pruned document is written as 3.1, which the webhooks section of 3.2 fits.
  if (!isRecord(document) || typeof document.openapi !== "string" || !/^3\.[12]\./.test(document.openapi)) {
    throw new Error(`${label} must be an OpenAPI 3.1 or 3.2 document; 3.0 has no webhooks section`);
  }
  if (!isRecord(document.webhooks)) throw new Error(`${label} has no webhooks section`);
  const components = isRecord(document.components) ? document.components : {};
  const schemas = isRecord(components.schemas) ? components.schemas : {};
  const requestBodies = isRecord(components.requestBodies) ? components.requestBodies : {};
  const webhooks = Object.fromEntries(
    Object.entries(document.webhooks).map(([name, webhook]) => [name, inlineRequestBody(webhook, requestBodies)]),
  );
  const reached = reachableSchemas(webhooks, schemas);
  const pruned: OpenAPIDocument = { openapi: "3.1.0", info: openapiInfo(document.info, given), webhooks };
  if (reached.size > 0) pruned.components = { schemas: Object.fromEntries([...reached].map((key) => [key, schemas[key]])) };
  return pruned;
}

/** What the sender passed, else the document's own title and description. */
function openapiInfo(own: unknown, { name, version, title, description }: DocumentInfo): OpenAPIInfo {
  const ownTitle = isRecord(own) && typeof own.title === "string" ? own.title : name;
  const ownDescription = isRecord(own) && typeof own.description === "string" ? own.description : undefined;
  const info: OpenAPIInfo = { title: title ?? ownTitle, version };
  const chosenDescription = description ?? ownDescription;
  // No description key at all when unset: an undefined value would change the hash.
  if (chosenDescription !== undefined) info.description = chosenDescription;
  return info;
}

/** `requestBody: { $ref: "#/components/requestBodies/X" }` copied in, since the registry reads bodies inline. */
function inlineRequestBody(webhook: unknown, requestBodies: Record<string, unknown>): unknown {
  if (!isRecord(webhook) || !isRecord(webhook.post) || !isRecord(webhook.post.requestBody)) return webhook;
  const ref = webhook.post.requestBody.$ref;
  const prefix = "#/components/requestBodies/";
  if (typeof ref !== "string" || !ref.startsWith(prefix)) return webhook;
  const key = ref.slice(prefix.length);
  if (!Object.hasOwn(requestBodies, key)) return webhook;
  return { ...webhook, post: { ...webhook.post, requestBody: requestBodies[key] } };
}

function reachableSchemas(root: unknown, schemas: Record<string, unknown>): Set<string> {
  const reached = new Set<string>();
  const stack: unknown[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!isRecord(node)) continue;
    const key = typeof node.$ref === "string" ? componentName(node.$ref) : null;
    if (key !== null && Object.hasOwn(schemas, key) && !reached.has(key)) {
      reached.add(key);
      stack.push(schemas[key]);
    }
    stack.push(...Object.values(node));
  }
  return reached;
}

/** One JSON Schema per file; the file name minus its extension is the event name. */
async function readSchemas(dir: string): Promise<Map<string, unknown>> {
  const schemas = new Map<string, unknown>();
  for (const entry of await listDir(dir)) {
    if (!entry.isFile() || !STRUCTURED.has(extname(entry.name))) continue;
    schemas.set(basename(entry.name, extname(entry.name)), await readStructured(join(dir, entry.name)));
  }
  if (schemas.size === 0) throw new Error(`${dir} has no .json or .yaml schema files`);
  return schemas;
}

/** A file is one example; a folder holds several examples of the event it's named after. */
async function readExamples(dir: string): Promise<Map<string, unknown>> {
  const schemas = new Map<string, unknown>();
  for (const entry of await listDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const files = (await listDir(path)).filter((file) => file.isFile() && STRUCTURED.has(extname(file.name)));
      const samples = await Promise.all(files.map((file) => readStructured(join(path, file.name))));
      if (samples.length > 0) schemas.set(entry.name, inferSchema(samples));
      continue;
    }
    if (!entry.isFile() || !STRUCTURED.has(extname(entry.name))) continue;
    schemas.set(basename(entry.name, extname(entry.name)), inferSchema([await readStructured(path)]));
  }
  if (schemas.size === 0) throw new Error(`${dir} has no example payloads (.json or .yaml files)`);
  return schemas;
}

async function listDir(dir: string) {
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new Error(`${dir} is not a directory`);
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => !entry.name.startsWith(".")).sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function readStructured(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8").catch((cause: unknown) => {
    throw new Error(`can't read ${path}`, { cause });
  });
  try {
    return extname(path) === ".json" ? JSON.parse(text) : parseYaml(text);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${path} isn't valid ${extname(path) === ".json" ? "JSON" : "YAML"}: ${reason}`, { cause });
  }
}
