import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_REGISTRY_URL, type Lang, findLang } from "@typedhook/verify/registry";
import { isRecord } from "./is-record";

const DEFAULT_OUT: Record<Lang, string> = { typescript: "src/webhooks", python: "webhooks", go: "webhooks" };

const PUBLISH_KEYS = ["name", "owner", "events", "export", "openapi", "schemas", "examples", "title", "description"] as const;

export type Env = Record<string, string | undefined>;

/** How `typedhook publish` builds the document; exactly one of events, openapi, schemas, examples. */
export type PublishConfig = Partial<Record<(typeof PUBLISH_KEYS)[number], string>>;

export type WebhooksConfig = {
  registry?: string;
  /** Language `pull` generates; TypeScript when unset. */
  lang?: Lang;
  /** Directory the generated files go to, relative to typedhook.json. */
  out?: string;
  /** `owner/name` → semver range */
  registries: Record<string, string>;
  publish?: PublishConfig;
};

export type LockEntry = { range: string; version: string; hash: string };

export type Lockfile = Record<string, LockEntry>;

export type Project = { root: string; config: WebhooksConfig };

/** The nearest typedhook.json from `cwd` up, with the directory it's in. */
export async function findProject(cwd: string): Promise<Project | null> {
  const root = await findUp(cwd, ["typedhook.json"]);
  if (root === null) return null;
  return { root, config: await readConfig(root) };
}

const PROJECT_MARKERS: Record<Lang, string[]> = {
  typescript: ["package.json"],
  python: ["pyproject.toml", "setup.py", "requirements.txt"],
  go: ["go.mod"],
};

/** Where typedhook.json goes when there's none: the nearest project in that language, else `cwd`. */
export async function findProjectRoot(cwd: string, lang: Lang): Promise<string> {
  return (await findUp(cwd, PROJECT_MARKERS[lang])) ?? cwd;
}

export function defaultConfig(lang: Lang = "typescript"): WebhooksConfig {
  if (lang === "typescript") return { out: DEFAULT_OUT.typescript, registries: {} };
  return { lang, out: DEFAULT_OUT[lang], registries: {} };
}

export function langOf(config: WebhooksConfig): Lang {
  return config.lang ?? "typescript";
}

export function outOf(config: WebhooksConfig): string {
  return config.out ?? DEFAULT_OUT[langOf(config)];
}

export async function readConfig(root: string): Promise<WebhooksConfig> {
  const path = join(root, "typedhook.json");
  const value = await readJson(path);
  const invalid = new Error(
    `${path} should look like { "out": "src/webhooks", "registries": { "owner/name": "^1.0.0" } }`,
  );
  if (!isRecord(value)) throw invalid;
  const { registry, lang, out, registries = {}, publish } = value;
  if (
    !isOptionalString(registry) ||
    !isOptionalString(lang) ||
    !isOptionalString(out) ||
    !isStringRecord(registries) ||
    (publish !== undefined && !isPublishConfig(publish))
  ) {
    throw invalid;
  }
  const config: WebhooksConfig = { registries };
  if (registry !== undefined) config.registry = registry;
  if (lang !== undefined) {
    const parsed = findLang(lang);
    if (parsed === null) throw new Error(`${path}: unknown lang "${lang}", expected typescript, python or go`);
    config.lang = parsed;
  }
  if (out !== undefined) config.out = out;
  if (publish !== undefined) config.publish = publish;
  return config;
}

/** A sender-only typedhook.json has no registries, so they're left out when empty. */
export async function writeConfig(root: string, { registries, ...rest }: WebhooksConfig): Promise<void> {
  const hasRegistries = Object.keys(registries).length > 0 || rest.out !== undefined;
  await writeJson(join(root, "typedhook.json"), hasRegistries ? { ...rest, registries } : rest);
}

/** typedhook.lock next to typedhook.json; empty when there's none yet. */
export async function readLock(root: string): Promise<Lockfile> {
  const path = join(root, "typedhook.lock");
  const text = await readText(path);
  if (text === null) return {};
  const value = parseJson(path, text);
  const malformed = new Error(`${path} is malformed; delete it and run \`typedhook pull\``);
  if (!isRecord(value)) throw malformed;
  const lock: Lockfile = {};
  for (const [registry, entry] of Object.entries(value)) {
    if (!isLockEntry(entry)) throw malformed;
    lock[registry] = entry;
  }
  return lock;
}

export async function writeLock(root: string, lock: Lockfile): Promise<void> {
  // Sorted so the file doesn't churn with the order registries were added in.
  const sorted: Lockfile = {};
  for (const registry of Object.keys(lock).sort()) sorted[registry] = lock[registry];
  await writeJson(join(root, "typedhook.lock"), sorted);
}

export function registryUrl(config: WebhooksConfig | undefined, env: Env): string {
  const url = env.TYPEDHOOK_REGISTRY_URL || config?.registry || DEFAULT_REGISTRY_URL;
  return url.replace(/\/+$/, "");
}

/** Null when the file doesn't exist. */
export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Leaves the file alone when it already has this content, so reruns don't touch it. */
export async function writeText(path: string, text: string): Promise<void> {
  if ((await readText(path)) === text) return;
  await writeFile(path, text);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  if (text === null) throw new Error(`${path} not found`);
  return parseJson(path, text);
}

function parseJson(path: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} is not valid JSON: ${reason}`);
  }
}

/** The nearest directory from `cwd` up holding any of `files`. */
async function findUp(cwd: string, files: string[]): Promise<string | null> {
  let dir = cwd;
  while (true) {
    for (const file of files) if (await exists(join(dir, file))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isPublishConfig(value: unknown): value is PublishConfig {
  if (!isRecord(value)) return false;
  const known = new Set<string>(PUBLISH_KEYS);
  return Object.entries(value).every(([key, item]) => known.has(key) && typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isLockEntry(value: unknown): value is LockEntry {
  return (
    isRecord(value) &&
    typeof value.range === "string" &&
    typeof value.version === "string" &&
    typeof value.hash === "string"
  );
}
