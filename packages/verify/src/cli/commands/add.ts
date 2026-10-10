import { join } from "node:path";
import {
  type Env,
  defaultConfig,
  findPackageRoot,
  findProject,
  readLock,
  readText,
  registryUrl,
  writeConfig,
  writeLock,
  writeText,
} from "../config";
import { generatedFiles, writeGeneratedFile } from "../generated-file";
import { withPostinstall } from "../postinstall";
import { type RegistryVersion, parseRegistry, resolveRegistry } from "../registry-client";

export type AddOptions = {
  /** Saved as `registry` in typedhook.json. */
  registryUrl?: string;
  cwd?: string;
  env?: Env;
  log?: (line: string) => void;
};

/** `typedhook add owner/name[@range]...` */
export async function add(
  specs: string[],
  { registryUrl: savedUrl, cwd = process.cwd(), env = process.env, log = console.log }: AddOptions = {},
): Promise<void> {
  if (specs.length === 0) throw new Error("usage: typedhook add owner/name[@range] ...");
  const { root, config } = (await findProject(cwd)) ?? {
    root: await findPackageRoot(cwd),
    config: defaultConfig(),
  };
  if (savedUrl) config.registry = savedUrl;
  const url = registryUrl(config, env);
  const lock = await readLock(root);

  const added = new Set(
    specs.map((spec) => {
      const { registry, range } = parseSpec(spec);
      config.registries[registry] = range;
      return registry;
    }),
  );
  // Fails on clashing file names before any request.
  const files = generatedFiles(config).filter((file) => added.has(file.registry));

  const pulled: { registry: string; range: string; path: string; resolved: RegistryVersion }[] = [];
  for (const { registry, range, path } of files) {
    const resolved = await resolveRegistry({ registryUrl: url, registry, range });
    const savedRange = range === "latest" ? `^${resolved.version}` : range;
    config.registries[registry] = savedRange;
    lock[registry] = { range: savedRange, version: resolved.version, hash: resolved.hash };
    pulled.push({ registry, range: savedRange, path, resolved });
  }
  for (const { registry, range, path, resolved } of pulled) {
    await writeGeneratedFile(join(root, path), registry, resolved);
    log(`added ${registry}@${range} (${resolved.version}) → ${path}`);
  }
  await writeConfig(root, config);
  await writeLock(root, lock);
  await addPostinstall(root, log);
}

/** `owner/name` resolves `latest`, saved as `^<version>`. */
function parseSpec(spec: string): { registry: string; range: string } {
  const [registry = "", range = "latest", ...rest] = spec.split("@");
  parseRegistry(registry);
  if (range === "" || rest.length > 0) {
    throw new Error(`invalid registry "${spec}": expected owner/name[@range]`);
  }
  return { registry, range };
}

async function addPostinstall(root: string, log: (line: string) => void): Promise<void> {
  const path = join(root, "package.json");
  const text = await readText(path);
  if (text === null) {
    log("no package.json found; run `typedhook pull` after installing dependencies");
    return;
  }
  const next = withPostinstall(text);
  if (next === null) return;
  await writeText(path, next);
  log("added `typedhook pull` to the postinstall script in package.json");
}
