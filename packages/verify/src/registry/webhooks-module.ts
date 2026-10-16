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
  const exports = exportsOf(module);

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
    const hasUnbranded = Object.values(exports).some((value) => isRecord(value) && typeof value.send === "function");
    const hint = hasUnbranded
      ? "; it exports an object with send(), so upgrade @typedhook/sdk to a version that marks its instances"
      : "; export the one you call send() on";
    throw new Error(`${path} doesn't export a webhooks() instance from @typedhook/sdk${hint}`);
  }
  if (others.length > 0) {
    const names = [...nameByInstance.values()].join(", ");
    throw new Error(
      `${path} exports several webhooks() instances (${names}); choose one with --export, or the action's export input`,
    );
  }
  return first["~typedhook"].events;
}

/**
 * Loaders hand back different shapes for one file: a CommonJS
 * `module.exports = wh` arrives as the instance itself, and CommonJS compiled
 * from `export default wh` nests its exports under `default`.
 */
function exportsOf(module: unknown): Record<string, unknown> {
  if (isBranded(module)) return { default: module, ...module };
  if (!isRecord(module)) return {};
  const { default: defaultExport } = module;
  if (isRecord(defaultExport) && !isBranded(defaultExport)) return { ...module, ...exportsOf(defaultExport) };
  return module;
}

function isBranded(value: unknown): value is Branded {
  if (!isRecord(value)) return false;
  const brand = value["~typedhook"];
  return isRecord(brand) && brand.version === 1 && isRecord(brand.events);
}
