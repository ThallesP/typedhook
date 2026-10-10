import { pathToFileURL } from "node:url";
import { createJiti } from "jiti/static";
import { isRecord } from "./is-record";

/**
 * jiti rather than a plain import: sender code may be TypeScript with
 * extensionless imports or CJS, which Node's type stripping won't run.
 * `jiti/static` imports its babel transform statically so ncc bundles it.
 */
export async function loadEvents(path: string, exportName: string): Promise<Record<string, unknown>> {
  const jiti = createJiti(pathToFileURL(path).href, { interopDefault: true });
  const module: unknown = await jiti.import(path);
  const events = isRecord(module) ? module[exportName] : undefined;
  if (!isRecord(events)) {
    throw new Error(`${path} has no "${exportName}" export holding an object of event schemas`);
  }
  return events;
}
