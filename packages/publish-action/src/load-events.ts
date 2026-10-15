import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WEBHOOKS_FILES, eventsFromModule } from "@typedhook/verify/registry";
import { createJiti } from "jiti/static";

/**
 * jiti rather than a plain import: sender code may be TypeScript with
 * extensionless imports or CJS, which Node's type stripping won't run.
 * `jiti/static` imports its babel transform statically so ncc bundles it.
 */
export async function loadEvents(
  workingDirectory: string,
  file: string,
  exportName: string,
): Promise<Record<string, unknown>> {
  const path = file ? resolve(workingDirectory, file) : await findWebhooksFile(workingDirectory);
  // Without interopDefault the namespace keeps every export, so a second instance can't hide behind the default.
  const jiti = createJiti(pathToFileURL(path).href, { interopDefault: false });
  return eventsFromModule(await jiti.import(path), path, exportName || undefined);
}

async function findWebhooksFile(workingDirectory: string): Promise<string> {
  for (const file of WEBHOOKS_FILES) {
    const path = resolve(workingDirectory, file);
    if (await exists(path)) return path;
  }
  throw new Error(
    `no webhooks file in ${workingDirectory}: looked for webhooks.ts (or .js) in ., src, lib, server and utils; set the webhooks input`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
