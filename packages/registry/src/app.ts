import { Elysia, type ElysiaAdapter } from "elysia";
import { maxSatisfying, valid, validRange } from "semver";
import type { VerifyGithubToken } from "./github-oidc";
import { canonicalJson, hashCanonical } from "./hash";
import { isRecord } from "./is-record";
import type { Store } from "./store";

const MAX_DOCUMENT_BYTES = 1_000_000;
const REGISTRY_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
// Other events (pull_request, pull_request_review, issue_comment, workflow_run...)
// can run code from whoever opened a pull request.
const ALLOWED_EVENTS = ["push", "release", "workflow_dispatch"];

const encoder = new TextEncoder();

export interface AppOptions {
  store: Store;
  verifyGithubToken: VerifyGithubToken;
  adapter?: ElysiaAdapter;
}

type DocumentResult =
  | { ok: true; canonical: string }
  | { ok: false; status: 400 | 413; error: string };

export function createApp({ store, verifyGithubToken, adapter }: AppOptions) {
  return new Elysia({ adapter })
    .onError(({ code, status }) => {
      if (code === "NOT_FOUND") return status(404, { error: "not found" });
      return status(500, { error: "internal error" });
    })
    .put(
      "/registries/:owner/:name/versions/:version",
      async ({ params, request, status }) => {
        // GitHub logins are case-insensitive, so registries are stored lowercased.
        const owner = params.owner.toLowerCase();
        const name = params.name.toLowerCase();
        const { version } = params;
        const token = bearerToken(request.headers.get("authorization"));
        if (!token) return status(401, { error: "missing bearer token" });
        const identity = await verifyGithubToken(token);
        if (!identity) return status(401, { error: "invalid token" });

        if (!ALLOWED_EVENTS.includes(identity.eventName)) {
          return status(403, {
            error: `pushes from ${identity.eventName} events are not allowed, only from ${ALLOWED_EVENTS.join(", ")}`,
          });
        }
        if (owner !== identity.repositoryOwner.toLowerCase()) {
          return status(403, { error: `token is for ${identity.repositoryOwner}, not ${owner}` });
        }
        if (!REGISTRY_NAME.test(name)) return status(400, { error: "invalid registry name" });
        if (valid(version) !== version) {
          return status(400, { error: "version must be strict semver, e.g. 1.4.0" });
        }

        const body = await readDocument(request);
        if (!body.ok) return status(body.status, { error: body.error });
        const hash = await hashCanonical(body.canonical);

        // Logins can be renamed and then taken by someone else; the numeric id can't.
        const boundOwnerId = await store.claimOwner(owner, identity.repositoryOwnerId);
        if (boundOwnerId !== identity.repositoryOwnerId) {
          return status(403, { error: `${owner} belongs to a different account` });
        }

        if (await store.insertVersion({ owner, name, version, hash, document: body.canonical })) {
          return status(201, { status: "created", version, hash });
        }
        const existing = await store.findVersion(owner, name, version);
        if (existing?.hash === hash) return { status: "unchanged", version, hash };
        return status(409, {
          error: `${owner}/${name}@${version} already exists with different content`,
        });
      },
      // Read the raw body ourselves to enforce the size limit and parse it once.
      { parse: "none" },
    )
    .get("/registries/:owner/:name/:range", async ({ params, status }) => {
      const owner = params.owner.toLowerCase();
      const name = params.name.toLowerCase();
      const { range } = params;
      const semverRange = range === "latest" ? "*" : range;
      if (validRange(semverRange) === null) return status(400, { error: "invalid semver range" });

      const versions = await store.listVersions(owner, name);
      if (versions.length === 0) return status(404, { error: `${owner}/${name} not found` });
      const noMatch = { error: `no version of ${owner}/${name} matches ${range}` };
      const version = resolveVersion(versions, semverRange);
      if (!version) return status(404, noMatch);

      const row = await store.findVersion(owner, name, version);
      if (!row) return status(404, noMatch);
      return { version: row.version, hash: row.hash, document: JSON.parse(row.document) };
    });
}

/**
 * Prereleases only match a range that names one, like semver does, except that
 * `*` falls back to the newest prerelease when there's no stable version yet.
 */
function resolveVersion(versions: string[], range: string): string | null {
  const stable = maxSatisfying(versions, range);
  if (stable || range !== "*") return stable;
  return maxSatisfying(versions, range, { includePrerelease: true });
}

function bearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer (\S+)$/i);
  return match?.[1] ?? null;
}

async function readDocument(request: Request): Promise<DocumentResult> {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return { ok: false, status: 413, error: "document is larger than 1 MB" };
  }
  const document = parseJson(bytes);
  if (!isRecord(document)) return { ok: false, status: 400, error: "body must be a JSON object" };
  const { openapi, webhooks } = document;
  if (typeof openapi !== "string" || !/^3\.1\.\d+$/.test(openapi)) {
    return { ok: false, status: 400, error: "openapi must be 3.1.x" };
  }
  if (!isRecord(webhooks)) {
    return { ok: false, status: 400, error: "document has no webhooks object" };
  }
  // The stored form can outgrow the body: numbers like 1e20 are written out in full.
  const canonical = canonicalJson(document);
  if (encoder.encode(canonical).byteLength > MAX_DOCUMENT_BYTES) {
    return { ok: false, status: 413, error: "canonical document is larger than 1 MB" };
  }
  return { ok: true, canonical };
}

function parseJson(bytes: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}
