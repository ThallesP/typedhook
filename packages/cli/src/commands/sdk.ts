import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type FetchImpl, type Lang, generatePackage, parseRegistry, resolveRegistry } from "@typedhook/verify/registry";
import { type Env, findProject, registryUrl, writeText } from "../config";

export type SdkCommandOptions = {
  lang: Lang;
  /** Directory to write the package into. */
  out: string;
  packageName?: string;
  cwd?: string;
  env?: Env;
  log?: (line: string) => void;
  fetchImpl?: FetchImpl;
};

/** `typedhook sdk owner/name[@range] --lang <lang> --out <dir>`: a package to publish under your own name. */
export async function sdk(
  spec: string,
  { lang, out, packageName, cwd = process.cwd(), env = process.env, log = console.log, fetchImpl = fetch }: SdkCommandOptions,
): Promise<void> {
  const [registry = "", range = "latest"] = spec.split("@");
  parseRegistry(registry);
  const url = registryUrl((await findProject(cwd))?.config, env);
  const { version, hash, document } = await resolveRegistry({ registryUrl: url, registry, range, fetchImpl });
  const generated = await generatePackage(lang, { registry, version, hash, document }, { packageName });
  const dir = resolve(cwd, out);
  for (const [path, text] of generated.files) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeText(join(dir, path), text);
  }
  log(`wrote ${generated.packageName} ${version} (${lang}) to ${out}: ${[...generated.files.keys()].join(", ")}`);
}
