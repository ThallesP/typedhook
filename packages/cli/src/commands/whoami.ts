import type { FetchImpl } from "@typedhook/verify/registry";
import { type Env, findProject, registryUrl } from "../config";
import { readCredentials } from "../credentials";
import { registryApi } from "../registry-api";

export type WhoamiOptions = { cwd?: string; env?: Env; log?: (line: string) => void; fetchImpl?: FetchImpl };

/** `typedhook whoami` */
export async function whoami({
  cwd = process.cwd(),
  env = process.env,
  log = console.log,
  fetchImpl = fetch,
}: WhoamiOptions = {}): Promise<void> {
  const url = registryUrl((await findProject(cwd))?.config, env);
  const token = env.TYPEDHOOK_TOKEN || (await readCredentials(url, env))?.token;
  if (!token) throw new Error("not signed in, run `npx typedhook login`");
  const { login, owners, staleOrgs } = await registryApi(url, fetchImpl).whoami(token);
  log(`${login} on ${url}; you can publish as ${owners.join(", ")}`);
  if (staleOrgs.length > 0) log(`run \`typedhook login\` again to publish for ${staleOrgs.join(", ")}`);
}
