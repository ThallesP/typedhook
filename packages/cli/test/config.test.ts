import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGISTRY_URL } from "@typedhook/verify/registry";
import {
  findProjectRoot,
  findProject,
  readConfig,
  readLock,
  registryUrl,
  writeConfig,
  writeLock,
} from "../src/config";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "webhooks-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("findProject", () => {
  test("finds typedhook.json in a parent directory", async () => {
    const nested = join(dir, "src", "routes");
    await mkdir(nested, { recursive: true });
    await writeFile(join(dir, "typedhook.json"), '{ "registries": { "acme/billing": "^1.0.0" } }');
    expect(await findProject(nested)).toEqual({
      root: dir,
      config: { registries: { "acme/billing": "^1.0.0" } },
    });
  });

  test("is null without a typedhook.json", async () => {
    expect(await findProject(dir)).toBeNull();
  });
});

describe("findProjectRoot", () => {
  test("is the nearest directory with the language's project file", async () => {
    const nested = join(dir, "src");
    await mkdir(nested);
    await writeFile(join(dir, "package.json"), "{}");
    expect(await findProjectRoot(nested, "typescript")).toBe(dir);
    expect(await findProjectRoot(nested, "go")).toBe(nested);
    await writeFile(join(nested, "pyproject.toml"), "");
    expect(await findProjectRoot(nested, "python")).toBe(nested);
  });
});

describe("readConfig", () => {
  test("keeps the registry URL", async () => {
    await writeFile(
      join(dir, "typedhook.json"),
      '{ "registry": "https://registry.test", "out": "types", "registries": {} }',
    );
    expect(await readConfig(dir)).toEqual({
      registry: "https://registry.test",
      out: "types",
      registries: {},
    });
  });

  test("rejects a malformed config", async () => {
    await writeFile(join(dir, "typedhook.json"), '{ "registries": { "acme/billing": 1 } }');
    await expect(readConfig(dir)).rejects.toThrow("typedhook.json should look like");
    await writeFile(join(dir, "typedhook.json"), "{ nope");
    await expect(readConfig(dir)).rejects.toThrow("typedhook.json is not valid JSON");
  });

  test("writes JSON with 2-space indent and a trailing newline", async () => {
    await writeConfig(dir, { out: "src/webhooks", registries: { "acme/billing": "^1.0.0" } });
    expect(await readFile(join(dir, "typedhook.json"), "utf8")).toBe(
      '{\n  "out": "src/webhooks",\n  "registries": {\n    "acme/billing": "^1.0.0"\n  }\n}\n',
    );
  });
});

describe("lock", () => {
  test("is empty when missing and round-trips sorted", async () => {
    expect(await readLock(dir)).toEqual({});
    const entry = { range: "^1.0.0", version: "1.0.0", hash: "sha256-x" };
    await writeLock(dir, { "zeta/events": entry, "acme/billing": entry });
    const text = await readFile(join(dir, "typedhook.lock"), "utf8");
    expect(Object.keys(JSON.parse(text))).toEqual(["acme/billing", "zeta/events"]);
    expect(await readLock(dir)).toEqual({ "acme/billing": entry, "zeta/events": entry });
  });

  test("rejects a malformed lock", async () => {
    await writeFile(join(dir, "typedhook.lock"), '{ "acme/billing": { "range": "^1.0.0" } }');
    await expect(readLock(dir)).rejects.toThrow("typedhook.lock is malformed");
  });
});

describe("registryUrl", () => {
  const config = { registry: "https://config.test/", out: "src/webhooks", registries: {} };

  test("prefers TYPEDHOOK_REGISTRY_URL, then the config, then the default", () => {
    expect(registryUrl(config, { TYPEDHOOK_REGISTRY_URL: "https://env.test" })).toBe("https://env.test");
    expect(registryUrl(config, {})).toBe("https://config.test");
    expect(registryUrl(undefined, {})).toBe(DEFAULT_REGISTRY_URL);
  });
});
