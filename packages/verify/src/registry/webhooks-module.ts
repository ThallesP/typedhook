import { isRecord } from "./is-record";

const DIRECTORIES = ["", "src/", "lib/", "src/lib/", "server/", "src/server/", "utils/", "src/utils/"];
const EXTENSIONS = ["ts", "mts", "cts", "js", "mjs", "cjs"];

/** Where `push` looks for the sender's webhooks() instance, like Better Auth looks for auth.ts. */
export const WEBHOOKS_FILES = DIRECTORIES.flatMap((directory) =>
  EXTENSIONS.map((extension) => `${directory}webhooks.${extension}`),
);

type Branded = { "~typedhook": { version: 1; events: Record<string, unknown> } };

/**
 * The events of the webhooks() instance `module` exports. Without `exportName`
 * it has to export exactly one, under any name or as the default.
 */
export function eventsFromModule(
  module: unknown,
  path: string,
  exportName?: string,
): Record<string, unknown> {
  // A CommonJS `module.exports = wh` comes back as the instance itself.
  if (isBranded(module)) return module["~typedhook"].events;
  const exports = isRecord(module) ? module : {};

  if (exportName) {
    const value = exports[exportName];
    if (!isBranded(value)) {
      throw new Error(`${path}: export "${exportName}" isn't a webhooks() instance from @typedhook/sdk`);
    }
    return value["~typedhook"].events;
  }

  // `export const wh = webhooks(...)` plus `export default wh` is one instance.
  const nameByInstance = new Map<Branded, string>();
  for (const [name, value] of Object.entries(exports)) {
    if (isBranded(value) && !nameByInstance.has(value)) nameByInstance.set(value, name);
  }
  const [first, ...others] = nameByInstance.keys();
  if (!first) {
    throw new Error(
      `${path} doesn't export a webhooks() instance from @typedhook/sdk; export the one you call send() on`,
    );
  }
  if (others.length > 0) {
    const names = [...nameByInstance.values()].join(", ");
    throw new Error(
      `${path} exports several webhooks() instances (${names}); choose one with --export, or the action's export input`,
    );
  }
  return first["~typedhook"].events;
}

function isBranded(value: unknown): value is Branded {
  if (!isRecord(value)) return false;
  const brand = value["~typedhook"];
  return isRecord(brand) && brand.version === 1 && isRecord(brand.events);
}
