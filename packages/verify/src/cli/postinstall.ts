import { isRecord } from "./is-record";

const PULL = "typedhook pull";

/** Whether package.json lists `name` in `dependencies`, which installs that skip devDependencies still get. */
export function hasDependency(packageJson: string, name: string): boolean {
  const pkg: unknown = JSON.parse(packageJson);
  return isRecord(pkg) && isRecord(pkg.dependencies) && Object.hasOwn(pkg.dependencies, name);
}

/** package.json text with `typedhook pull` in its postinstall script, or null when it's already there. */
export function withPostinstall(packageJson: string): string | null {
  const pkg: unknown = JSON.parse(packageJson);
  if (!isRecord(pkg)) throw new Error("package.json is not a JSON object");
  const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};
  const { postinstall } = scripts;
  if (typeof postinstall === "string" && postinstall.includes(PULL)) return null;

  const hasPostinstall = typeof postinstall === "string" && postinstall.trim() !== "";
  const command = hasPostinstall ? `${postinstall} && ${PULL}` : PULL;
  const next = { ...pkg, scripts: { ...scripts, postinstall: command } };
  const indent = /^\{\r?\n([ \t]+)"/.exec(packageJson)?.[1] ?? "  ";
  return `${JSON.stringify(next, null, indent)}\n`;
}
