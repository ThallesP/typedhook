import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type OpenAPIInfo, isStrictSemver, pushDocument, toOpenAPI } from "@typedhook/verify/registry";
import { type Env, findProject, registryUrl } from "../config";
import { githubOidcToken } from "../github-oidc";
import { isRecord } from "../is-record";

export type PushOptions = {
  /** Module exporting the event map. */
  events: string;
  name: string;
  version: string;
  /** Export holding the event map. */
  exportName?: string;
  title?: string;
  description?: string;
  /** Write the document here instead of uploading it. */
  out?: string;
  /** Defaults to `GITHUB_REPOSITORY_OWNER`. */
  owner?: string;
  cwd?: string;
  env?: Env;
  log?: (line: string) => void;
};

/** `typedhook push --events <file> --name <name> --version <semver>` */
export async function push({
  events,
  name,
  version,
  exportName = "events",
  title = name,
  description,
  out,
  owner,
  cwd = process.cwd(),
  env = process.env,
  log = console.log,
}: PushOptions): Promise<void> {
  if (!isStrictSemver(version)) {
    throw new Error(
      `--version must be strict semver like 1.4.0 or 2.0.0-beta.1, got ${JSON.stringify(version)}`,
    );
  }
  const info: OpenAPIInfo = { title, version };
  if (description) info.description = description;
  const document = toOpenAPI(await loadEvents(resolve(cwd, events), exportName), info);

  if (out) {
    await writeFile(resolve(cwd, out), `${JSON.stringify(document, null, 2)}\n`);
    log(`wrote ${out}`);
    return;
  }

  const registryOwner = owner ?? env.GITHUB_REPOSITORY_OWNER;
  if (!registryOwner) throw new Error("pass --owner (GITHUB_REPOSITORY_OWNER isn't set)");
  const registry = `${registryOwner}/${name}`;
  const project = await findProject(cwd);
  const url = registryUrl(project?.config, env);
  const token = await githubOidcToken({ audience: url, env });
  const { status, hash } = await pushDocument({ registryUrl: url, registry, version, document, token });
  log(`${status} ${registry}@${version} (${hash})`);
}

async function loadEvents(path: string, exportName: string): Promise<Record<string, unknown>> {
  const module = await importModule(path);
  const events = isRecord(module) ? module[exportName] : undefined;
  if (!isRecord(events)) {
    throw new Error(`${path} has no "${exportName}" export holding an object of event schemas`);
  }
  return events;
}

async function importModule(path: string): Promise<unknown> {
  try {
    return await import(pathToFileURL(path).href);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    // Native import only strips types on Bun and Node 22.18+; the CLI supports Node 20.
    const hint = /\.[cm]?tsx?$/.test(path)
      ? ". TypeScript event files need Bun or Node 22.18+; on older Node, point --events at compiled JavaScript"
      : "";
    throw new Error(`can't import ${path}: ${reason}${hint}`, { cause });
  }
}
