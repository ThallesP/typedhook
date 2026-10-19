import {
  type Bump,
  LANGS,
  type SchemaChange,
  canonicalJson,
  diffDocuments,
  findLang,
  generateCode,
  hashText,
  readRegistryDocument,
} from "@typedhook/verify/registry";
import { Elysia, type ElysiaAdapter } from "elysia";
import { lt, maxSatisfying, rsort, valid, validRange } from "semver";
import type { GithubDevice } from "./github-device";
import type { VerifyGithubToken } from "./github-oidc";
import { isRecord } from "./is-record";
import { type McpOptions, handleMcp } from "./mcp";
import type { Org, Store, VersionInfo, VersionRow } from "./store";
import { homePage, notFoundPage, registryPage } from "./pages/render";
import { newToken, tokenHash } from "./tokens";

const MAX_DOCUMENT_BYTES = 1_000_000;
// Hashing and type generation recurse into the document, so a 1 MB body of
// nested arrays would overflow the stack.
const MAX_DEPTH = 256;
const REGISTRY_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
// Other events (pull_request, pull_request_review, issue_comment, workflow_run...)
// can run code from whoever opened a pull request.
const ALLOWED_EVENTS = ["push", "release", "workflow_dispatch"];

const encoder = new TextEncoder();

// The pages have no scripts of their own; everything they show comes from
// published documents. The one script allowed is the Web Analytics beacon
// Cloudflare injects into the zone's pages.
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; script-src https://static.cloudflareinsights.com; connect-src https://cloudflareinsights.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  // A new publish shows up within a minute.
  "cache-control": "public, max-age=60",
};

const BUMPS = new Map<string, Bump>([
  ["major", "major"],
  ["minor", "minor"],
  ["patch", "patch"],
]);

export interface AppOptions {
  store: Store;
  verifyGithubToken: VerifyGithubToken;
  /** Null when the registry has no GitHub OAuth app, so only GitHub Actions can publish. */
  githubDevice: GithubDevice | null;
  adapter?: ElysiaAdapter;
}

type DocumentResult =
  | { ok: true; text: string; canonical: string; document: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string };

/** Who's publishing: the owners they may publish as (lowercased login → GitHub id). */
type Publisher = { owners: Map<string, string>; publishedBy: string };

type AuthResult = { ok: true; publisher: Publisher } | { ok: false; status: 401 | 403; error: string };

export type Resolved = { ok: true; row: VersionRow } | { ok: false; status: 400 | 404; error: string };

export function createApp({ store, verifyGithubToken, githubDevice, adapter }: AppOptions) {
  async function authenticate(header: string | null): Promise<AuthResult> {
    const token = bearerToken(header);
    if (!token) return { ok: false, status: 401, error: "missing bearer token" };
    if (token.startsWith("th_")) {
      const user = await store.findToken(await tokenHash(token));
      if (!user) return { ok: false, status: 401, error: "invalid token, run `typedhook login` again" };
      const orgs = await store.listMemberships(user.userId);
      return { ok: true, publisher: { owners: ownersOf(user.login, user.userId, orgs), publishedBy: user.login } };
    }
    const identity = await verifyGithubToken(token);
    if (!identity) return { ok: false, status: 401, error: "invalid token" };
    if (!ALLOWED_EVENTS.includes(identity.eventName)) {
      return {
        ok: false,
        status: 403,
        error: `pushes from ${identity.eventName} events are not allowed, only from ${ALLOWED_EVENTS.join(", ")}`,
      };
    }
    const owners = new Map([[identity.repositoryOwner.toLowerCase(), identity.repositoryOwnerId]]);
    return { ok: true, publisher: { owners, publishedBy: `${identity.repository} (GitHub Actions)` } };
  }

  async function resolve(owner: string, name: string, range: string): Promise<Resolved> {
    const semverRange = range === "latest" ? "*" : range;
    if (validRange(semverRange) === null) return { ok: false, status: 400, error: "invalid semver range" };
    const versions = await store.listVersions(owner, name);
    if (versions.length === 0) return { ok: false, status: 404, error: `${owner}/${name} not found` };
    const noMatch: Resolved = { ok: false, status: 404, error: `no version of ${owner}/${name} matches ${range}` };
    const version = resolveVersion(versions, semverRange);
    if (!version) return noMatch;
    const row = await store.findVersion(owner, name, version);
    if (!row) return noMatch;
    return { ok: true, row };
  }

  const mcpOptions: McpOptions = { store, resolve };

  async function sortedVersions(owner: string, name: string) {
    const rows = await store.listVersionInfo(owner, name);
    const byVersion = new Map(rows.map((row) => [row.version, row]));
    return rsort(rows.map((row) => row.version)).flatMap((version) => {
      const row = byVersion.get(version);
      return row ? [parseVersionInfo(row)] : [];
    });
  }

  return new Elysia({ adapter })
    .onError(({ code, error, status }) => {
      if (code === "NOT_FOUND") return status(404, { error: "not found" });
      console.error(error);
      return status(500, { error: "internal error" });
    })
    .put(
      "/registries/:owner/:name/versions/:version",
      async ({ params, request, status }) => {
        // GitHub logins are case-insensitive, so registries are stored lowercased.
        const owner = params.owner.toLowerCase();
        const name = params.name.toLowerCase();
        const { version } = params;
        const auth = await authenticate(request.headers.get("authorization"));
        if (!auth.ok) return status(auth.status, { error: auth.error });
        const { owners, publishedBy } = auth.publisher;
        const ownerId = owners.get(owner);
        if (ownerId === undefined) {
          return status(403, { error: `you can publish as ${[...owners.keys()].join(", ")}, not ${owner}` });
        }
        if (!REGISTRY_NAME.test(name)) return status(400, { error: "invalid registry name" });
        if (valid(version) !== version) {
          return status(400, { error: "version must be strict semver, e.g. 1.4.0" });
        }

        const body = await readDocument(request);
        if (!body.ok) return status(body.status, { error: body.error });
        const hash = await hashText(body.canonical);

        // Logins can be renamed and then taken by someone else; the numeric id can't.
        const boundOwnerId = await store.claimOwner(owner, ownerId);
        if (boundOwnerId !== ownerId) {
          return status(403, { error: `${owner} belongs to a different account` });
        }

        const versions = await store.listVersions(owner, name);
        const diff = await diffWithPrevious(owner, name, version, versions, body.document);
        const { info } = body.document;
        const title = isRecord(info) && typeof info.title === "string" ? info.title : name;
        const description = isRecord(info) && typeof info.description === "string" ? info.description : null;
        // Store the body as sent so the sender's property order comes back on resolve.
        const isCreated = await store.insertVersion({
          owner,
          name,
          version,
          hash,
          document: body.text,
          bump: diff?.bump ?? null,
          changes: diff ? JSON.stringify(diff.changes) : null,
          publishedBy,
        });
        if (!isCreated) {
          const existing = await store.findVersion(owner, name, version);
          if (existing?.hash === hash) return { status: "unchanged", version, hash };
          return status(409, { error: `${owner}/${name}@${version} already exists with different content` });
        }
        if (resolveVersion([...versions, version], "*") === version) {
          await store.updateRegistry({ owner, name, title, description, latest: version });
        }
        return status(201, { status: "created", version, hash, bump: diff?.bump ?? null, changes: diff?.changes ?? [] });
      },
      // Read the raw body ourselves to enforce the size limit and parse it once.
      { parse: "none" },
    )
    .get("/registries", async ({ query }) => {
      const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
      return { registries: await store.searchRegistries(String(query.q ?? ""), limit) };
    })
    .get("/registries/:owner/:name", async ({ params, status }) => {
      const owner = params.owner.toLowerCase();
      const name = params.name.toLowerCase();
      const registry = await store.findRegistry(owner, name);
      if (!registry) return status(404, { error: `${owner}/${name} not found` });
      return { ...registry, versions: await sortedVersions(owner, name) };
    })
    .get("/registries/:owner/:name/:range", async ({ params, status }) => {
      const result = await resolve(params.owner.toLowerCase(), params.name.toLowerCase(), params.range);
      if (!result.ok) return status(result.status, { error: result.error });
      const { row } = result;
      return { version: row.version, hash: row.hash, document: JSON.parse(row.document) };
    })
    .get("/registries/:owner/:name/:range/code/:lang", async ({ params, status }) => {
      const lang = findLang(params.lang);
      if (lang === null) return status(400, { error: `lang must be one of ${LANGS.join(", ")}` });
      const result = await resolve(params.owner.toLowerCase(), params.name.toLowerCase(), params.range);
      if (!result.ok) return status(result.status, { error: result.error });
      const { row } = result;
      const code = await generateCode(lang, {
        registry: `${row.owner}/${row.name}`,
        version: row.version,
        hash: row.hash,
        document: JSON.parse(row.document),
      });
      return new Response(code, { headers: { "content-type": "text/plain; charset=utf-8" } });
    })
    .post("/auth/device", async ({ status }) => {
      if (!githubDevice) return status(503, { error: "this registry can't sign in with GitHub" });
      return githubDevice.start();
    })
    .post(
      "/auth/device/token",
      async ({ request, status }) => {
        if (!githubDevice) return status(503, { error: "this registry can't sign in with GitHub" });
        const body: unknown = await request.json().catch(() => undefined);
        const deviceCode = isRecord(body) ? body.deviceCode : undefined;
        if (typeof deviceCode !== "string" || deviceCode === "") return status(400, { error: "deviceCode is required" });
        const poll = await githubDevice.poll(deviceCode);
        if (poll.status === "pending") return status(202, { status: "pending", interval: poll.interval });
        if (poll.status === "expired") return status(410, { error: "the code expired, run `typedhook login` again" });
        if (poll.status === "denied") return status(403, { error: "access was denied on GitHub" });
        const { account } = poll;
        const token = newToken();
        await store.createToken(await tokenHash(token), { userId: account.id, login: account.login.toLowerCase() });
        await store.replaceMemberships(account.id, account.orgs);
        return { token, login: account.login.toLowerCase(), owners: [...ownersOf(account.login, account.id, account.orgs).keys()] };
      },
      { parse: "none" },
    )
    .get("/auth/whoami", async ({ request, status }) => {
      const token = bearerToken(request.headers.get("authorization"));
      const user = token?.startsWith("th_") ? await store.findToken(await tokenHash(token)) : null;
      if (!user) return status(401, { error: "not signed in, run `typedhook login`" });
      const orgs = await store.listMemberships(user.userId);
      return { login: user.login, owners: [...ownersOf(user.login, user.userId, orgs).keys()] };
    })
    .delete("/auth/token", async ({ request, status }) => {
      const token = bearerToken(request.headers.get("authorization"));
      if (token?.startsWith("th_")) await store.deleteToken(await tokenHash(token));
      return status(204, null);
    })
    .post("/mcp", ({ request }) => handleMcp(request, mcpOptions), { parse: "none" })
    .get("/mcp", ({ status }) => status(405, { error: "the MCP endpoint takes POST requests" }))
    .get("/", async ({ query }) => {
      const search = String(query.q ?? "").slice(0, 200);
      return new Response(homePage({ registries: await store.searchRegistries(search, 60), query: search }), {
        headers: PAGE_HEADERS,
      });
    })
    .get("/:owner/:name", async ({ params, query }) => {
      const owner = params.owner.toLowerCase();
      const name = params.name.toLowerCase();
      const summary = await store.findRegistry(owner, name);
      if (!summary) return new Response(notFoundPage(`${owner}/${name} isn't on the registry`), { status: 404, headers: PAGE_HEADERS });
      const versions = await sortedVersions(owner, name);
      const asked = typeof query.version === "string" ? query.version : summary.latest;
      const version = versions.some((each) => each.version === asked) ? asked : summary.latest;
      const row = await store.findVersion(owner, name, version);
      if (!row) return new Response(notFoundPage(`${owner}/${name}@${version} isn't on the registry`), { status: 404, headers: PAGE_HEADERS });
      const page = await registryPage({ summary, versions, version, document: JSON.parse(row.document) });
      return new Response(page, { headers: PAGE_HEADERS });
    });

  async function diffWithPrevious(
    owner: string,
    name: string,
    version: string,
    versions: string[],
    document: Record<string, unknown>,
  ) {
    const [previous] = rsort(versions.filter((each) => lt(each, version)));
    if (previous === undefined) return null;
    const row = await store.findVersion(owner, name, previous);
    if (!row) return null;
    return diffDocuments(JSON.parse(row.document), document);
  }
}

function parseVersionInfo({ changes, bump, ...row }: VersionInfo) {
  const parsed: unknown = changes === null ? null : JSON.parse(changes);
  return {
    ...row,
    bump: (bump === null ? undefined : BUMPS.get(bump)) ?? null,
    changes: Array.isArray(parsed) ? parsed.filter(isSchemaChange) : null,
  };
}

function isSchemaChange(value: unknown): value is SchemaChange {
  return (
    isRecord(value) &&
    typeof value.bump === "string" &&
    BUMPS.has(value.bump) &&
    typeof value.event === "string" &&
    typeof value.path === "string" &&
    typeof value.message === "string"
  );
}

function ownersOf(login: string, userId: string, orgs: Org[]): Map<string, string> {
  return new Map([[login.toLowerCase(), userId], ...orgs.map((org): [string, string] => [org.login.toLowerCase(), org.id])]);
}

/**
 * Prereleases only match a range that names one, like semver does, except that
 * `*` falls back to the newest prerelease when there's no stable version yet.
 */
export function resolveVersion(versions: string[], range: string): string | null {
  const stable = maxSatisfying(versions, range);
  if (stable || range !== "*") return stable;
  return maxSatisfying(versions, range, { includePrerelease: true });
}

function bearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer (\S+)$/i);
  return match?.[1] ?? null;
}

async function readDocument(request: Request): Promise<DocumentResult> {
  const bytes = await readBody(request);
  if (!bytes) return { ok: false, status: 413, error: "document is larger than 1 MB" };
  const text = decodeUtf8(bytes);
  if (text === null) return { ok: false, status: 400, error: "body must be UTF-8" };
  const document = parseJson(text);
  if (!isRecord(document)) return { ok: false, status: 400, error: "body must be a JSON object" };
  if (nestedDeeperThan(document, MAX_DEPTH)) {
    return { ok: false, status: 400, error: `document is nested deeper than ${MAX_DEPTH} levels` };
  }
  const { openapi, webhooks } = document;
  if (typeof openapi !== "string" || !/^3\.1\.\d+$/.test(openapi)) {
    return { ok: false, status: 400, error: "openapi must be 3.1.x" };
  }
  if (!isRecord(webhooks)) {
    return { ok: false, status: 400, error: "document has no webhooks object" };
  }
  // Every consumer generator reads the document this way, so a document they
  // can't read is refused here rather than failing on every `typedhook pull`.
  try {
    readRegistryDocument("document", document);
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : String(error) };
  }
  // The stored form can outgrow the body: numbers like 1e20 are written out in full.
  const canonical = canonicalJson(document);
  if (encoder.encode(canonical).byteLength > MAX_DOCUMENT_BYTES) {
    return { ok: false, status: 413, error: "canonical document is larger than 1 MB" };
  }
  return { ok: true, text, canonical, document };
}

/** Null once the body passes the size limit, without reading the rest of it. */
async function readBody(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length")) > MAX_DOCUMENT_BYTES) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Walks with an explicit stack, since recursing is what the limit guards against. */
function nestedDeeperThan(value: unknown, limit: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [current, depth] = next;
    if (typeof current !== "object" || current === null) continue;
    if (depth > limit) return true;
    for (const child of Object.values(current)) stack.push([child, depth + 1]);
  }
  return false;
}
