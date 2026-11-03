import { type FetchImpl, eventKey, parseRegistry, readRegistryDocument, resolveRegistry } from "@typedhook/verify/registry";
import { type Env, findProject, registryUrl } from "../config";
import { registryApi } from "../registry-api";

export type InfoOptions = { cwd?: string; env?: Env; log?: (line: string) => void; fetchImpl?: FetchImpl };

/** `typedhook info owner/name[@range]`: the events and versions of one registry. */
export async function info(
  spec: string,
  { cwd = process.cwd(), env = process.env, log = console.log, fetchImpl = fetch }: InfoOptions = {},
): Promise<void> {
  const [registry = "", range = "latest"] = spec.split("@");
  const { owner, name } = parseRegistry(registry);
  const url = registryUrl((await findProject(cwd))?.config, env);
  const listing = await registryApi(url, fetchImpl).info(owner, name);
  const { version, document } = await resolveRegistry({ registryUrl: url, registry, range, fetchImpl });
  const model = readRegistryDocument(`${registry}@${version}`, document);
  log(`${listing.owner}/${listing.name}@${version}  ${listing.title}${listing.description ? `: ${listing.description}` : ""}`);
  log(`${url}/${listing.owner}/${listing.name}`);
  log("");
  log(`events${model.discriminator ? ` (named by "${model.discriminator.property}")` : ""}:`);
  for (const event of model.events) log(`  ${eventKey(model, event)}${event.description ? `  ${event.description}` : ""}`);
  log("");
  log("versions:");
  for (const each of listing.versions) {
    log(`  ${each.version}${each.bump ? ` (${each.bump})` : ""}  ${each.createdAt}${each.publishedBy ? `  by ${each.publishedBy}` : ""}`);
  }
}
