import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type OpenAPIInfo, isStrictSemver, pushDocument, toOpenAPI } from "@typedhook/verify/registry";
import { type Env, findProject, registryUrl } from "../config";
import { githubOidcToken } from "../github-oidc";
import { loadEvents } from "../load-events";

export type PushOptions = {
  /** Module exporting the webhooks() instance; found by name when unset. */
  webhooks?: string;
  name: string;
  version: string;
  /** Export holding the instance, when the module exports several. */
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

/** `typedhook push --name <name> --version <semver> [--webhooks <file>]` */
export async function push({
  webhooks,
  name,
  version,
  exportName,
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
  const document = toOpenAPI(await loadEvents({ cwd, file: webhooks, exportName }), info);

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
