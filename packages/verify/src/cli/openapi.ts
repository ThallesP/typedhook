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
  const webhooks: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};
  const owners = new Map<string, string>();
  for (const name of Object.keys(events).sort()) {
    const hoisted = hoistDefs(name, toJsonSchema(name, events[name]));
    for (const [key, schema] of Object.entries(hoisted.schemas)) {
      // Event `a` with def `b.c` and event `a.b` with def `c` both hoist to `a.b.c`.
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw new Error(
          `events "${owner}" and "${name}" both define the component schema "${key}"; rename one of them`,
        );
      }
      owners.set(key, name);
      schemas[key] = schema;
    }
    webhooks[name] = {
      post: {
        operationId: name,
        requestBody: {
          required: true,
          content: { "application/json": { schema: envelope(name, hoisted.data) } },
        },
        responses: { "2XX": { description: "Return any 2XX status to acknowledge the event" } },
      },
    };
  }

  const document: OpenAPIDocument = { openapi: "3.1.0", info, webhooks };
  if (Object.keys(schemas).length > 0) document.components = { schemas };
  return document;
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
): { data: unknown; schemas: Record<string, unknown> } {
  // $schema is dropped: OpenAPI 3.1 already defaults to the 2020-12 dialect.
  const { $schema, $defs, ...root } = jsonSchema;
  let isRecursive = false;
  function rewrite(value: unknown): unknown {
    return mapRefs(value, (ref) => {
      if (ref === "#") {
        isRecursive = true;
        return componentRef(name);
      }
      if (ref.startsWith("#/$defs/")) return componentRef(`${name}.${ref.slice("#/$defs/".length)}`);
      return ref;
    });
  }

  const schemas: Record<string, unknown> = {};
  for (const [defName, def] of Object.entries(isRecord($defs) ? $defs : {})) {
    schemas[`${name}.${defName}`] = rewrite(def);
  }
  const data = rewrite(root);
  if (!isRecursive) return { data, schemas };
  schemas[name] = data;
  return { data: { $ref: componentRef(name) }, schemas };
}

function mapRefs(value: unknown, mapRef: (ref: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapRefs(item, mapRef));
  if (!isRecord(value)) return value;
  const mapped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    mapped[key] = key === "$ref" && typeof child === "string" ? mapRef(child) : mapRefs(child, mapRef);
  }
  return mapped;
}

function componentRef(key: string): string {
  return `#/components/schemas/${key}`;
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
