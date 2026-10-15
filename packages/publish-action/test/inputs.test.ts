import { describe, expect, test } from "bun:test";
import { DEFAULT_REGISTRY_URL } from "@typedhook/verify/registry";
import { type Env, parseInputs } from "../src/inputs";

const env: Env = { GITHUB_REPOSITORY_OWNER: "acme", GITHUB_REF: "refs/tags/v1.4.0" };

function getInputFrom(values: Record<string, string>) {
  return (name: string) => values[name] ?? "";
}

describe("parseInputs", () => {
  test("applies defaults and takes the version from the tag", () => {
    expect(parseInputs(getInputFrom({ name: "billing" }), env)).toEqual({
      webhooks: "",
      exportName: "",
      registry: "acme/billing",
      version: "1.4.0",
      title: "billing",
      description: "",
      registryUrl: DEFAULT_REGISTRY_URL,
      workingDirectory: ".",
      isDryRun: false,
      outputFile: "",
    });
  });

  test("keeps a tag without a leading v as is", () => {
    const inputs = parseInputs(getInputFrom({ name: "billing" }), {
      ...env,
      GITHUB_REF: "refs/tags/2.0.0-beta.1",
    });
    expect(inputs.version).toBe("2.0.0-beta.1");
  });

  test("an explicit version wins over the tag", () => {
    const inputs = parseInputs(getInputFrom({ name: "billing", version: "1.5.0" }), env);
    expect(inputs.version).toBe("1.5.0");
  });

  test.each(["1.4", "1.4.0+build.5", "1.4.0\nexport const pwned = 1;"])(
    "rejects version %p, which the registry won't store",
    (version) => {
      expect(() => parseInputs(getInputFrom({ name: "billing", version }), env)).toThrow(
        "version must be strict semver",
      );
    },
  );

  test("rejects a tag that isn't a version", () => {
    expect(() =>
      parseInputs(getInputFrom({ name: "billing" }), {
        ...env,
        GITHUB_REF: "refs/tags/release-7",
      }),
    ).toThrow('version must be strict semver like 1.4.0 or 2.0.0-beta.1, got "release-7"');
  });

  test("strips trailing slashes from the registry URL, which is also the OIDC audience", () => {
    const inputs = parseInputs(
      getInputFrom({ name: "billing", "registry-url": "https://reg.example//" }),
      env,
    );
    expect(inputs.registryUrl).toBe("https://reg.example");
  });

  test("fails without a version outside a tag run", () => {
    expect(() =>
      parseInputs(getInputFrom({ name: "billing" }), {
        ...env,
        GITHUB_REF: "refs/heads/main",
      }),
    ).toThrow('input "version" is required');
  });

  test("passes the other inputs through", () => {
    const inputs = parseInputs(
      getInputFrom({
        webhooks: "src/lib/webhooks.ts",
        export: "wh",
        name: "billing",
        title: "Billing",
        description: "Billing events",
        "registry-url": "https://registry.test",
        "working-directory": "apps/api",
        "output-file": "openapi.json",
      }),
      env,
    );
    expect(inputs).toMatchObject({
      webhooks: "src/lib/webhooks.ts",
      exportName: "wh",
      title: "Billing",
      description: "Billing events",
      registryUrl: "https://registry.test",
      workingDirectory: "apps/api",
      outputFile: "openapi.json",
    });
  });

  test.each([
    ["true", true],
    ["True", true],
    ["false", false],
    ["FALSE", false],
  ])("parses dry-run %p", (value, isDryRun) => {
    const inputs = parseInputs(getInputFrom({ name: "billing", "dry-run": value }), env);
    expect(inputs.isDryRun).toBe(isDryRun);
  });

  test("rejects a dry-run that isn't a boolean", () => {
    expect(() =>
      parseInputs(getInputFrom({ name: "billing", "dry-run": "yes" }), env),
    ).toThrow('input "dry-run" must be true or false, got "yes"');
  });

  test("requires name", () => {
    expect(() => parseInputs(getInputFrom({}), env)).toThrow('input "name" is required');
  });

  test("rejects a name the registry won't accept", () => {
    expect(() => parseInputs(getInputFrom({ name: "-billing" }), env)).toThrow(
      'invalid registry "acme/-billing"',
    );
  });
});
