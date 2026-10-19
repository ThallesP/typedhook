import { componentRef, unescapePointerToken } from "./component-ref";
import { isRecord } from "./is-record";
import { isStandardJSONSchema } from "./standard-json-schema";

export type OpenAPIInfo = { title: string; version: string; description?: string };

export type OpenAPIDocument = {
  openapi: string;
  info: OpenAPIInfo;
  webhooks: Record<string, unknown>;
  components?: { schemas: Record<string, unknown> };
};

/**
 * One webhook per event, each posting the envelope `{ event, subject, data }`
 * that @typedhook/sdk sends.
 */
export function toOpenAPI(events: Record<string, unknown>, info: OpenAPIInfo): OpenAPIDocument {
  const schemas = new Map(Object.keys(events).map((name) => [name, toJsonSchema(name, events[name])]));
  return buildDocument(schemas, info, (name, data) => {
    // `.describe()` on an event's schema describes the event, so it moves onto
    // the operation instead of showing on both the event and its `data`.
    if (!isRecord(data) || typeof data.description !== "string") return { body: envelope(name, data) };
    const { description, ...rest } = data;
    return { body: envelope(name, rest), description };
  });
}

/**
 * One webhook per event from plain JSON Schemas of the whole request body, for
 * senders that don't use @typedhook/sdk. A Map, since event names come from
 * file names and `__proto__` is a valid one.
 */
export function schemasToOpenAPI(payloads: Map<string, unknown>, info: OpenAPIInfo): OpenAPIDocument {
  const schemas = new Map(
    [...payloads].map(([name, schema]): [string, Record<string, unknown>] => {
      if (!isRecord(schema)) throw new Error(`event "${name}": its JSON Schema is not an object`);
      return [name, schema];
    }),
  );
  return buildDocument(schemas, info, (_name, payload) => ({ body: payload }));
}

function buildDocument(
  jsonSchemas: Map<string, Record<string, unknown>>,
  info: OpenAPIInfo,
  wrap: (name: string, data: unknown) => { body: unknown; description?: string },
): OpenAPIDocument {
  // Maps until the end: assigning a `__proto__` key on an object sets its prototype instead.
  const webhooks = new Map<string, unknown>();
  const schemas = new Map<string, unknown>();
  const owners = new Map<string, string>();
  for (const [name, jsonSchema] of [...jsonSchemas].sort(byName)) {
    const hoisted = hoistDefs(name, jsonSchema);
    for (const [key, schema] of hoisted.schemas) {
      // Event `a` with def `b.c` and event `a.b` with def `c` both hoist to `a.b.c`.
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw new Error(
          `events "${owner}" and "${name}" both define the component schema "${key}"; rename one of them`,
        );
      }
      owners.set(key, name);
      schemas.set(key, schema);
    }
    const { body, description } = wrap(name, hoisted.data);
    const operation: Record<string, unknown> = {
      operationId: name,
      requestBody: { required: true, content: { "application/json": { schema: body } } },
      responses: { "2XX": { description: "Return any 2XX status to acknowledge the event" } },
    };
    if (description !== undefined) operation.description = description;
    webhooks.set(name, { post: operation });
  }

  const document: OpenAPIDocument = { openapi: "3.1.0", info, webhooks: Object.fromEntries(webhooks) };
  if (schemas.size > 0) document.components = { schemas: Object.fromEntries(schemas) };
  return document;
}

/** UTF-16 order like Array.prototype.sort, not localeCompare, so the document is the same on every machine. */
function byName([a]: [string, unknown], [b]: [string, unknown]): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function toJsonSchema(name: string, schema: unknown): Record<string, unknown> {
  if (!isStandardJSONSchema(schema)) {
    throw new Error(
      `event "${name}": schema doesn't implement Standard JSON Schema (zod >= 4.2, ArkType and Valibot do)`,
    );
  }
  try {
    // Round-tripped so metadata like `examples: [new Date(0)]` is plain JSON,
    // hashing here the way the registry hashes what it receives.
    const json: unknown = JSON.parse(
      JSON.stringify(schema["~standard"].jsonSchema.output({ target: "draft-2020-12" })),
    );
    if (isRecord(json)) return json;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `event "${name}" can't be converted to JSON Schema: ${reason}. Payloads are JSON, so send dates as ISO strings (z.iso.datetime() instead of z.date())`,
      { cause },
    );
  }
  throw new Error(`event "${name}": its JSON Schema is not an object`);
}

/**
 * 2020-12 resolves `#/...` refs against the document root, so an event's
 * `$defs` (and a root self-reference `#`) would dangle once nested under
 * `webhooks`. They move to `components.schemas`, namespaced by event name.
 */
function hoistDefs(
  name: string,
  jsonSchema: Record<string, unknown>,
): { data: unknown; schemas: Map<string, unknown> } {
  // $schema is dropped: OpenAPI 3.1 already defaults to the 2020-12 dialect.
  const { $schema, $defs, ...root } = jsonSchema;
  let isRecursive = false;
  function rewrite(value: unknown): unknown {
    return mapRefs(value, (ref) => {
      if (ref === "#") {
        isRecursive = true;
        return componentRef(name);
      }
      if (!ref.startsWith("#/$defs/")) return ref;
      // A ref may point inside a def (`#/$defs/a/properties/b`); only the def name is renamed.
      const [defToken = "", ...path] = ref.slice("#/$defs/".length).split("/");
      return [componentRef(`${name}.${unescapePointerToken(defToken)}`), ...path].join("/");
    });
  }

  const schemas = new Map<string, unknown>();
  for (const [defName, def] of Object.entries(isRecord($defs) ? $defs : {})) {
    schemas.set(`${name}.${defName}`, rewrite(def));
  }
  const data = rewrite(root);
  if (!isRecursive) return { data, schemas };
  schemas.set(name, data);
  return { data: { $ref: componentRef(name) }, schemas };
}

function mapRefs(value: unknown, mapRef: (ref: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapRefs(item, mapRef));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "$ref" && typeof child === "string" ? mapRef(child) : mapRefs(child, mapRef),
    ]),
  );
}

function envelope(name: string, data: unknown): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      event: { type: "string", const: name },
      subject: { type: ["string", "null"] },
      data,
    },
    required: ["event", "subject", "data"],
    additionalProperties: false,
  };
}
