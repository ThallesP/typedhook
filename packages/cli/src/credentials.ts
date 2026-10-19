import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Env } from "./config";
import { isRecord } from "./is-record";

export type Credentials = { token: string; login: string };

/** `$XDG_CONFIG_HOME/typedhook/credentials.json`, one entry per registry URL. */
export function credentialsPath(env: Env): string {
  const base = env.XDG_CONFIG_HOME || (env.APPDATA ?? join(env.HOME || homedir(), ".config"));
  return join(base, "typedhook", "credentials.json");
}

export async function readCredentials(registryUrl: string, env: Env): Promise<Credentials | null> {
  const entry = (await readAll(env))[registryUrl];
  if (!isRecord(entry) || typeof entry.token !== "string" || typeof entry.login !== "string") return null;
  return { token: entry.token, login: entry.login };
}

export async function saveCredentials(registryUrl: string, credentials: Credentials, env: Env): Promise<void> {
  await writeAll(env, { ...(await readAll(env)), [registryUrl]: credentials });
}

export async function deleteCredentials(registryUrl: string, env: Env): Promise<void> {
  const { [registryUrl]: _removed, ...rest } = await readAll(env);
  if (Object.keys(rest).length === 0) {
    await rm(credentialsPath(env), { force: true });
    return;
  }
  await writeAll(env, rest);
}

async function readAll(env: Env): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(credentialsPath(env), "utf8"));
    return isRecord(value) ? value : {};
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeAll(env: Env, all: Record<string, unknown>): Promise<void> {
  const path = credentialsPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Owner-only: the file holds tokens that can publish.
  await writeFile(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}
