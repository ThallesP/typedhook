import { resolve } from "node:path";
import { WEBHOOKS_FILES, eventsFromModule } from "@typedhook/verify/registry";
import { createJiti } from "jiti";
import { exists } from "./config";

export type LoadEventsOptions = {
  cwd: string;
  /** The module exporting the webhooks() instance; searched for when unset. */
  file?: string;
  exportName?: string;
};

/**
 * Imports the sender's webhooks file and reads the events off its instance.
 * jiti rather than a plain import, so TypeScript with extensionless imports
 * and CJS load on every Node version the CLI supports.
 */
export async function loadEvents({ cwd, file, exportName }: LoadEventsOptions): Promise<Record<string, unknown>> {
  const path = file ? resolve(cwd, file) : await findWebhooksFile(cwd);
  return eventsFromModule(await importModule(path), path, exportName);
}

async function importModule(path: string): Promise<unknown> {
  // Without interopDefault the namespace keeps every export, so a second instance can't hide behind the default.
  const jiti = createJiti(import.meta.url, { interopDefault: false });
  try {
    return await jiti.import(path);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`can't import ${path}: ${reason}`, { cause });
  }
}

async function findWebhooksFile(cwd: string): Promise<string> {
  for (const file of WEBHOOKS_FILES) {
    const path = resolve(cwd, file);
    if (await exists(path)) return path;
  }
  throw new Error(
    `no webhooks file in ${cwd}: looked for webhooks.ts (or .js) in ., src, lib, server and utils; pass --webhooks <file>`,
  );
}
