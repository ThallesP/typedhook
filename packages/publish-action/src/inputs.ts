import { isStrictSemver, parseRegistry } from "@typedhook/verify/registry";

export type Inputs = {
  events: string;
  exportName: string;
  /** `owner/name`, the owner being the repository owner the OIDC token is issued for. */
  registry: string;
  version: string;
  title: string;
  description: string;
  registryUrl: string;
  workingDirectory: string;
  isDryRun: boolean;
  outputFile: string;
};

export type GetInput = (name: string) => string;

export type Env = Record<string, string | undefined>;

const TAG_REF = /^refs\/tags\/v?(.+)$/;

/** Inputs come back as "" when unset, so defaults apply here too, not only through action.yml. */
export function parseInputs(getInput: GetInput, env: Env): Inputs {
  const name = requireInput(getInput, "name");
  const owner = env.GITHUB_REPOSITORY_OWNER;
  if (!owner) throw new Error("GITHUB_REPOSITORY_OWNER is not set; run this action inside GitHub Actions");
  const registry = `${owner}/${name}`;
  parseRegistry(registry);
  // Checked here too so a dry run catches what the registry would reject.
  const version = getInput("version") || versionFromTag(env);
  if (!isStrictSemver(version)) {
    throw new Error(`version must be strict semver like 1.4.0 or 2.0.0-beta.1, got "${version}"`);
  }

  return {
    events: requireInput(getInput, "events"),
    exportName: getInput("export") || "events",
    registry,
    version,
    title: getInput("title") || name,
    description: getInput("description"),
    // Normalized once: it's both the OIDC audience and the base URL, and the
    // registry only accepts tokens whose audience is its exact URL.
    registryUrl: (getInput("registry-url") || "http://localhost:8787").replace(/\/+$/, ""),
    workingDirectory: getInput("working-directory") || ".",
    isDryRun: parseBoolean(getInput("dry-run"), "dry-run"),
    outputFile: getInput("output-file"),
  };
}

function requireInput(getInput: GetInput, name: string): string {
  const value = getInput(name);
  if (!value) throw new Error(`input "${name}" is required`);
  return value;
}

function versionFromTag(env: Env): string {
  const match = TAG_REF.exec(env.GITHUB_REF ?? "");
  if (!match?.[1]) {
    throw new Error(
      `input "version" is required when the run isn't for a tag (GITHUB_REF is "${env.GITHUB_REF ?? ""}"); trigger on tags like v1.4.0 or pass version`,
    );
  }
  return match[1];
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "" || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  throw new Error(`input "${name}" must be true or false, got "${value}"`);
}
