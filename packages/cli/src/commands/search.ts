import type { FetchImpl } from "@typedhook/verify/registry";
import { type Env, findProject, registryUrl } from "../config";
import { registryApi } from "../registry-api";

export type SearchOptions = { cwd?: string; env?: Env; log?: (line: string) => void; fetchImpl?: FetchImpl };

/** `typedhook search [query]`: which products publish their webhooks here. */
export async function search(
  query: string,
  { cwd = process.cwd(), env = process.env, log = console.log, fetchImpl = fetch }: SearchOptions = {},
): Promise<void> {
  const url = registryUrl((await findProject(cwd))?.config, env);
  const registries = await registryApi(url, fetchImpl).search(query);
  if (registries.length === 0) {
    log(query ? `nothing matches "${query}"` : "the registry is empty");
    return;
  }
  for (const { owner, name, latest, title, description } of registries) {
    log(`${owner}/${name}@${latest}  ${title}${description ? `: ${description}` : ""}`);
  }
}
