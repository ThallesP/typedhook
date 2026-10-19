import type { FetchImpl } from "@typedhook/verify/registry";
import { type Env, findProject, registryUrl } from "../config";
import { deleteCredentials, readCredentials } from "../credentials";
import { registryApi } from "../registry-api";

export type LogoutOptions = { cwd?: string; env?: Env; log?: (line: string) => void; fetchImpl?: FetchImpl };

/** `typedhook logout`: revokes the token on the registry and forgets it here. */
export async function logout({
  cwd = process.cwd(),
  env = process.env,
  log = console.log,
  fetchImpl = fetch,
}: LogoutOptions = {}): Promise<void> {
  const url = registryUrl((await findProject(cwd))?.config, env);
  const credentials = await readCredentials(url, env);
  if (!credentials) {
    log("not signed in");
    return;
  }
  await registryApi(url, fetchImpl).revoke(credentials.token);
  await deleteCredentials(url, env);
  log(`signed out ${credentials.login}`);
}
