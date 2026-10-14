import { join } from "node:path";
import { resolveRegistry } from "@typedhook/verify/registry";
import {
  type Env,
  type LockEntry,
  type Lockfile,
  findProject,
  readLock,
  registryUrl,
  writeLock,
} from "../config";
import { type GeneratedFile, generatedFiles, staleReason, writeGeneratedFile } from "../generated-file";

export type PullOptions = {
  /** Re-resolve every range instead of using the locked versions. */
  update?: boolean;
  /** Write nothing; fail when a generated file or the lock is out of date. */
  check?: boolean;
  cwd?: string;
  env?: Env;
  log?: (line: string) => void;
};

/** `typedhook pull` */
export async function pull({
  update = false,
  check = false,
  cwd = process.cwd(),
  env = process.env,
  log = console.log,
}: PullOptions = {}): Promise<void> {
  const project = await findProject(cwd);
  if (!project) {
    // Runs from postinstall, so a project without registries must not fail.
    log("typedhook: no typedhook.json found, nothing to pull");
    return;
  }
  const { root, config } = project;
  const files = generatedFiles(config);
  const lock = await readLock(root);

  if (check) {
    const problems = await outdated(root, files, lock);
    if (problems.length > 0) {
      const lines = problems.map((problem) => `  ${problem}`);
      throw new Error(["webhook types are out of date, run `typedhook pull`:", ...lines].join("\n"));
    }
    log("webhook types are up to date");
    return;
  }

  const url = registryUrl(config, env);
  const nextLock: Lockfile = {};
  let pulled = 0;
  for (const { registry, range, path } of files) {
    const locked: LockEntry | undefined = lock[registry];
    const isLocked = locked !== undefined && locked.range === range && !update;
    if (isLocked && (await staleReason(join(root, path), registry, locked)) === null) {
      nextLock[registry] = locked;
      continue;
    }

    const resolved = await resolveRegistry({
      registryUrl: url,
      registry,
      range: isLocked ? locked.version : range,
    });
    if (isLocked && resolved.version !== locked.version) {
      throw new Error(
        `asked the registry for ${registry}@${locked.version}, but it sent ${resolved.version}`,
      );
    }
    // Versions are immutable, so the locked one should never change.
    if (isLocked && resolved.hash !== locked.hash) {
      throw new Error(
        `${registry}@${locked.version} hashes to ${resolved.hash}, but typedhook.lock has ${locked.hash}`,
      );
    }
    await writeGeneratedFile(join(root, path), registry, resolved);
    nextLock[registry] = { range, version: resolved.version, hash: resolved.hash };
    log(`${registry}@${resolved.version} → ${path}`);
    pulled++;
  }
  await writeLock(root, nextLock);
  if (pulled === 0) log("webhook types are up to date");
}

async function outdated(root: string, files: GeneratedFile[], lock: Lockfile): Promise<string[]> {
  const problems: string[] = [];
  for (const { registry, range, path } of files) {
    const locked: LockEntry | undefined = lock[registry];
    if (locked === undefined) {
      problems.push(`${registry} is missing from typedhook.lock`);
      continue;
    }
    if (locked.range !== range) {
      problems.push(`${registry} is locked to ${locked.range}, but typedhook.json asks for ${range}`);
    }
    const reason = await staleReason(join(root, path), registry, locked);
    if (reason !== null) problems.push(`${path} ${reason}`);
  }
  const configured = new Set(files.map((file) => file.registry));
  for (const registry of Object.keys(lock)) {
    if (!configured.has(registry)) problems.push(`${registry} is in typedhook.lock but not in typedhook.json`);
  }
  return problems;
}
