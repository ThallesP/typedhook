import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  type Bump,
  type DocumentDiff,
  type FetchImpl,
  type OpenAPIDocument,
  RegistryError,
  type SchemaChange,
  diffDocuments,
  isBumpEnough,
  isStrictSemver,
  nextVersion,
  pushDocument,
  resolveRegistry,
  versionBump,
} from "@typedhook/verify/registry";
import { type Env, type PublishConfig, findProject, readText, registryUrl, writeConfig } from "../config";
import { readCredentials } from "../credentials";
import { githubOidcToken } from "../github-oidc";
import { isRecord } from "../is-record";
import { registryApi } from "../registry-api";
import { buildDocument, sourceOf } from "../sources";

const REGISTRY_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export type PublishOptions = {
  /** From flags; they win over typedhook.json and are saved there once a publish succeeds. */
  settings?: PublishConfig;
  /** Picked from the changes since the latest version when unset. */
  version?: string;
  isDryRun?: boolean;
  /** Also write the document here. */
  out?: string;
  cwd?: string;
  env?: Env;
  log?: (line: string) => void;
  fetchImpl?: FetchImpl;
};

const BUMP_MARKS: Record<Bump, string> = { major: "!", minor: "+", patch: "~" };

type LatestRelease = DocumentDiff & { version: string };

/** `typedhook publish` */
export async function publish({
  settings = {},
  version: requestedVersion,
  isDryRun = false,
  out,
  cwd = process.cwd(),
  env = process.env,
  log = console.log,
  fetchImpl = fetch,
}: PublishOptions = {}): Promise<void> {
  if (requestedVersion !== undefined && !isStrictSemver(requestedVersion)) {
    throw new Error(`--version must be strict semver like 1.4.0 or 2.0.0-beta.1, got ${JSON.stringify(requestedVersion)}`);
  }
  const project = await findProject(cwd);
  const root = project?.root ?? cwd;
  const saved = project?.config.publish ?? {};
  const merged: PublishConfig = { ...saved, ...settings };
  const source = sourceOf(merged);
  const name = (merged.name ?? (await defaultName(root))).toLowerCase();
  if (!REGISTRY_NAME.test(name)) {
    throw new Error(`"${name}" can't be a registry name: use lowercase letters, digits, ".", "_" and "-" (pass --name)`);
  }
  const url = registryUrl(project?.config, env);
  const credentials = await readCredentials(url, env);
  const owner = (merged.owner ?? env.GITHUB_REPOSITORY_OWNER ?? credentials?.login ?? (await tokenOwner(url, env, fetchImpl)))?.toLowerCase();
  if (!owner) throw new Error("who are you publishing as? run `npx typedhook login`, or pass --owner");
  const registry = `${owner}/${name}`;

  const draft = await buildDocument(source, { name, version: "0.0.0", title: merged.title, description: merged.description }, root);
  const latest = await latestRelease(url, registry, draft, fetchImpl);
  if (latest && latest.bump === null && requestedVersion === undefined) {
    log(`nothing changed since ${registry}@${latest.version}, so nothing to publish`);
    return;
  }
  const version = requestedVersion ?? (latest?.bump ? nextVersion(latest.version, latest.bump) : "1.0.0");
  if (latest && requestedVersion !== undefined) checkBump(latest, version);
  const document = { ...draft, info: { ...draft.info, version } };

  const events = Object.keys(document.webhooks).length;
  const from = latest ? `${latest.version} → ${version}${latest.bump ? ` (${latest.bump})` : ""}` : `${version}, first version`;
  log(`${registry} ${from}, ${events} ${events === 1 ? "event" : "events"} from ${source.path}`);
  for (const change of latest?.changes ?? []) log(`  ${formatChange(change)}`);

  if (out) {
    const outPath = resolve(cwd, out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`);
    log(`wrote ${out}`);
  }
  if (isDryRun) {
    log("dry run: nothing was uploaded");
    return;
  }

  const token = await publishToken(url, env, credentials?.token, fetchImpl);
  const result = await pushDocument({ registryUrl: url, registry, version, document, token, fetchImpl });
  log(`${result.status} ${registry}@${version}: ${url}/${registry}`);
  log(`consumers run: npx typedhook add ${registry}`);

  const next = { ...merged, name };
  if (JSON.stringify(next) !== JSON.stringify(saved)) {
    const config = project?.config ?? { registries: {} };
    await writeConfig(root, { ...config, publish: next });
    log("saved these settings to typedhook.json, so next time it's just `typedhook publish`");
  }
}

/** A version that doesn't cover the changes would break consumers on a semver range. */
function checkBump({ version: previous, bump: needed, changes }: LatestRelease, version: string): void {
  const made = versionBump(previous, version);
  // Backports and prereleases below the latest version aren't compared with it.
  if (needed === null || made === null || isBumpEnough(made, needed)) return;
  const lines = changes.filter((change) => change.bump === needed).map((change) => `  ${formatChange(change)}`);
  throw new Error(
    [
      `${version} is a ${made} release, but these changes since ${previous} need a ${needed} one (${nextVersion(previous, needed)}):`,
      ...lines,
    ].join("\n"),
  );
}

function formatChange({ bump, event, path, message }: SchemaChange): string {
  const where = [event, path].filter(Boolean).join(" ");
  return `${BUMP_MARKS[bump]} ${where ? `${where} ` : ""}${message}`;
}

/** The latest published version and how `draft` changes it, or null before the first publish. */
async function latestRelease(
  url: string,
  registry: string,
  draft: OpenAPIDocument,
  fetchImpl: FetchImpl,
): Promise<LatestRelease | null> {
  try {
    const { version, document } = await resolveRegistry({ registryUrl: url, registry, range: "latest", fetchImpl });
    return { version, ...diffDocuments(document, draft) };
  } catch (error) {
    if (error instanceof RegistryError && error.status === 404) return null;
    throw error;
  }
}

/**
 * TYPEDHOOK_TOKEN, else GitHub Actions' OIDC token when the job may mint one,
 * else the token `typedhook login` saved.
 */
async function publishToken(url: string, env: Env, saved: string | undefined, fetchImpl: FetchImpl): Promise<string> {
  if (env.TYPEDHOOK_TOKEN) return env.TYPEDHOOK_TOKEN;
  if (env.TYPEDHOOK_OIDC_TOKEN || env.ACTIONS_ID_TOKEN_REQUEST_URL) return githubOidcToken({ audience: url, env, fetchImpl });
  if (saved) return saved;
  throw new Error(
    "not signed in: run `npx typedhook login`; in GitHub Actions grant the job `permissions: id-token: write`; elsewhere set TYPEDHOOK_TOKEN",
  );
}

async function tokenOwner(url: string, env: Env, fetchImpl: FetchImpl): Promise<string | undefined> {
  if (!env.TYPEDHOOK_TOKEN) return undefined;
  const { login } = await registryApi(url, fetchImpl).whoami(env.TYPEDHOOK_TOKEN);
  return login;
}

/** The package's name without its scope, else the directory's. */
async function defaultName(root: string): Promise<string> {
  const text = await readText(join(root, "package.json"));
  const pkg: unknown = text === null ? null : JSON.parse(text);
  if (isRecord(pkg) && typeof pkg.name === "string" && pkg.name !== "") return pkg.name.replace(/^@[^/]+\//, "");
  return basename(root);
}
