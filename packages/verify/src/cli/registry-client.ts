import { hashDocument } from "./hash";
import { isRecord } from "./is-record";

// Replaced with the hosted registry's URL once it's deployed.
export const DEFAULT_REGISTRY_URL = "http://localhost:8787";

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export type RegistryVersion = { version: string; hash: string; document: Record<string, unknown> };

export type PushResult = { status: "created" | "unchanged"; version: string; hash: string };

export type ResolveRegistryOptions = {
  registryUrl: string;
  /** `owner/name` */
  registry: string;
  /** Semver range (an exact version is a range too), or `latest`. */
  range: string;
  fetchImpl?: FetchImpl;
};

export type PushDocumentOptions = {
  registryUrl: string;
  /** `owner/name` */
  registry: string;
  version: string;
  document: unknown;
  /** GitHub Actions OIDC token. */
  token: string;
  fetchImpl?: FetchImpl;
};

// Each part follows the registry server's name rule.
const REGISTRY = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/;

// semver.org's regex minus build metadata, which the registry rejects.
const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/;

export function parseRegistry(registry: string): { owner: string; name: string } {
  const match = REGISTRY.exec(registry);
  if (!match?.[1] || !match[2]) throw new Error(`invalid registry "${registry}": expected owner/name`);
  return { owner: match[1], name: match[2] };
}

/** A version the registry accepts: `1.4.0`, `2.0.0-beta.1`. No `v` prefix, no build metadata. */
export function isStrictSemver(version: string): boolean {
  // 256 is the semver package's length limit, which the registry validates with.
  return version.length <= 256 && STRICT_SEMVER.test(version);
}

/** The highest version matching `range`, after checking the document against its hash. */
export async function resolveRegistry({
  registryUrl,
  registry,
  range,
  fetchImpl = fetch,
}: ResolveRegistryOptions): Promise<RegistryVersion> {
  const url = `${registryBaseUrl(registryUrl, registry)}/${encodeURIComponent(range)}`;
  const body = await requestJson(fetchImpl, url, { method: "GET" });
  if (
    !isRecord(body) ||
    typeof body.version !== "string" ||
    typeof body.hash !== "string" ||
    !isRecord(body.document)
  ) {
    throw new Error(`registry sent an unexpected response for ${registry}@${range}`);
  }
  // The version ends up in generated code and the lock, so a hostile registry
  // mustn't get anything but a version through.
  if (!isStrictSemver(body.version)) {
    throw new Error(
      `registry sent an invalid version for ${registry}@${range}: ${JSON.stringify(body.version)}`,
    );
  }

  const hash = await hashDocument(body.document);
  if (hash !== body.hash) {
    throw new Error(
      `${registry}@${body.version}: document hashes to ${hash}, but the registry says ${body.hash}`,
    );
  }
  return { version: body.version, hash, document: body.document };
}

export async function pushDocument({
  registryUrl,
  registry,
  version,
  document,
  token,
  fetchImpl = fetch,
}: PushDocumentOptions): Promise<PushResult> {
  const url = `${registryBaseUrl(registryUrl, registry)}/versions/${encodeURIComponent(version)}`;
  const body = await requestJson(fetchImpl, url, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(document),
  });
  if (
    !isRecord(body) ||
    (body.status !== "created" && body.status !== "unchanged") ||
    typeof body.version !== "string" ||
    typeof body.hash !== "string"
  ) {
    throw new Error(`registry sent an unexpected response for ${registry}@${version}`);
  }
  return { status: body.status, version: body.version, hash: body.hash };
}

function registryBaseUrl(registryUrl: string, registry: string): string {
  const { owner, name } = parseRegistry(registry);
  return `${registryUrl.replace(/\/+$/, "")}/registries/${owner}/${name}`;
}

async function requestJson(fetchImpl: FetchImpl, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetchImpl(url, init);
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) return body;
  const reason = isRecord(body) && typeof body.error === "string" ? body.error : response.statusText;
  throw new Error(`registry responded ${response.status}: ${reason}`);
}
