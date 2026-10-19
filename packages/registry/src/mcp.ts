import {
  type Bump,
  LANGS,
  eventKey,
  findLang,
  generateCode,
  parseRegistry,
  readRegistryDocument,
} from "@typedhook/verify/registry";
import type { Resolved } from "./app";
import { isRecord } from "./is-record";
import type { Store } from "./store";

export type McpOptions = {
  store: Store;
  resolve: (owner: string, name: string, range: string) => Promise<Resolved>;
  /** Newest first, as `GET /registries/:owner/:name` lists them. */
  versions: (owner: string, name: string) => Promise<{ version: string; bump: Bump | null; createdAt: string }[]>;
};

type Args = Record<string, unknown>;

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Args, options: McpOptions) => Promise<string>;
};

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const registryArg = { type: "string", description: "owner/name, e.g. acme/billing" };
const versionArg = { type: "string", description: "Semver range or version; defaults to latest" };

const tools: Tool[] = [
  {
    name: "search_registries",
    description:
      "Find products whose webhook events are published on typedhook, by product name, owner or keyword. Empty query lists the most recently updated.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    async run({ query }, { store }) {
      const registries = await store.searchRegistries(typeof query === "string" ? query : "", 20);
      if (registries.length === 0) return "No registries match.";
      return registries
        .map((row) => `${row.owner}/${row.name}@${row.latest}: ${row.title}${row.description ? `. ${row.description}` : ""}`)
        .join("\n");
    },
  },
  {
    name: "get_registry",
    description:
      "The webhook events one product sends: each event's name and description, the field that names the event, the versions with what changed, and how to install typed SDKs for them.",
    inputSchema: { type: "object", properties: { registry: registryArg, version: versionArg }, required: ["registry"] },
    async run(args, options) {
      const { owner, name, row } = await resolveArgs(args, options);
      const model = readRegistryDocument(`${owner}/${name}`, JSON.parse(row.document));
      const versions = await options.versions(owner, name);
      const lines = [
        `${owner}/${name}@${row.version}`,
        model.discriminator
          ? `Payloads name their event in the "${model.discriminator.property}" field.`
          : "Payloads don't carry their event name; it comes from the request (a header or URL).",
        "",
        "Events:",
        ...model.events.map((event) => `- ${eventKey(model, event)}${event.description ? `: ${event.description}` : ""}`),
        "",
        "Install typed code:",
        `- TypeScript: npx typedhook add ${owner}/${name}`,
        `- Python: npx typedhook add ${owner}/${name} --lang python`,
        `- Go: npx typedhook add ${owner}/${name} --lang go`,
        "",
        "Versions:",
        ...versions.map((each) => `- ${each.version}${each.bump ? ` (${each.bump})` : ""} ${each.createdAt}`),
      ];
      return lines.join("\n");
    },
  },
  {
    name: "get_event",
    description: "The JSON Schema of one webhook event's payload, with the component schemas it refers to and example payloads.",
    inputSchema: {
      type: "object",
      properties: { registry: registryArg, event: { type: "string" }, version: versionArg },
      required: ["registry", "event"],
    },
    async run(args, options) {
      const { owner, name, row } = await resolveArgs(args, options);
      const document: unknown = JSON.parse(row.document);
      const model = readRegistryDocument(`${owner}/${name}`, document);
      const event = model.events.find((each) => each.name === args.event || eventKey(model, each) === args.event);
      if (!event) throw new Error(`${owner}/${name}@${row.version} has no event ${JSON.stringify(args.event)}`);
      const schemas = Object.keys(model.schemas).length > 0 ? { components: { schemas: model.schemas } } : {};
      return JSON.stringify({ event: eventKey(model, event), payload: event.payload, ...schemas }, null, 2);
    },
  },
  {
    name: "generate_code",
    description:
      "Typed source code for a product's webhook events: types for every payload plus Standard Webhooks signature verification. Prefer running `npx typedhook add` in the project, which also keeps it updated.",
    inputSchema: {
      type: "object",
      properties: { registry: registryArg, lang: { type: "string", enum: [...LANGS] }, version: versionArg },
      required: ["registry", "lang"],
    },
    async run(args, options) {
      const lang = typeof args.lang === "string" ? findLang(args.lang) : null;
      if (lang === null) throw new Error(`lang must be one of ${LANGS.join(", ")}`);
      const { row } = await resolveArgs(args, options);
      return generateCode(lang, {
        registry: `${row.owner}/${row.name}`,
        version: row.version,
        hash: row.hash,
        document: JSON.parse(row.document),
      });
    },
  },
];

const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

const methods = new Map<string, (params: Args, options: McpOptions) => Promise<unknown>>([
  [
    "initialize",
    async ({ protocolVersion }) => ({
      protocolVersion:
        typeof protocolVersion === "string" && SUPPORTED_PROTOCOLS.includes(protocolVersion)
          ? protocolVersion
          : SUPPORTED_PROTOCOLS[0],
      capabilities: { tools: {} },
      serverInfo: { name: "typedhook", version: "1.0.0" },
      instructions:
        "typedhook is a registry of webhook event schemas. Search for the product that sends the webhooks, read its events, then add typed code to the project with `npx typedhook add owner/name`.",
    }),
  ],
  ["ping", async () => ({})],
  ["tools/list", async () => ({ tools: tools.map(({ run, ...tool }) => tool) })],
  [
    "tools/call",
    async ({ name, arguments: args }, options) => {
      const tool = typeof name === "string" ? toolsByName.get(name) : undefined;
      if (!tool) throw new RpcError(-32602, `unknown tool ${JSON.stringify(name)}`);
      try {
        const text = await tool.run(isRecord(args) ? args : {}, options);
        return { content: [{ type: "text", text }] };
      } catch (error) {
        // Tool failures go back to the model as results so it can correct itself.
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  ],
]);

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A stateless MCP server over Streamable HTTP: every POST is one JSON-RPC
 * message answered with JSON, so there's no session to keep.
 */
export async function handleMcp(request: Request, options: McpOptions): Promise<Response> {
  const message: unknown = await request.json().catch(() => undefined);
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "expected one JSON-RPC 2.0 request" } }, 400);
  }
  const { id, method, params } = message;
  if (id === undefined) return new Response(null, { status: 202 });
  const handle = methods.get(method);
  if (!handle) return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  try {
    return json({ jsonrpc: "2.0", id, result: await handle(isRecord(params) ? params : {}, options) });
  } catch (error) {
    const code = error instanceof RpcError ? error.code : -32603;
    return json({ jsonrpc: "2.0", id, error: { code, message: error instanceof Error ? error.message : String(error) } });
  }
}

async function resolveArgs(args: Args, { resolve }: McpOptions) {
  const registry = typeof args.registry === "string" ? args.registry : "";
  const { owner, name } = parseRegistry(registry);
  const range = typeof args.version === "string" && args.version !== "" ? args.version : "latest";
  const resolved = await resolve(owner.toLowerCase(), name.toLowerCase(), range);
  if (!resolved.ok) throw new Error(resolved.error);
  return { owner: owner.toLowerCase(), name: name.toLowerCase(), row: resolved.row };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
