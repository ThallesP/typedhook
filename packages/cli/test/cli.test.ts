import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATOR_VERSION, canonicalJson, generateTypes, hashDocument } from "@typedhook/verify/registry";
import { createApp } from "../../registry/src/app";
import { githubVerifier } from "../../registry/src/github-oidc";
import { d1Store } from "../../registry/src/store";
import { memoryD1 } from "../../registry/test/d1";
import { AUDIENCE, keySet, signGithubToken } from "../../registry/test/github-token";
import { billingDocument } from "../../verify/test/fixtures/billing";
import { add } from "../src/commands/add";
import { pull } from "../src/commands/pull";
import { push } from "../src/commands/push";
import { readLock, writeLock } from "../src/config";

const app = createApp({
  store: d1Store(memoryD1()),
  verifyGithubToken: githubVerifier({ audience: AUDIENCE, keySet }),
});
const token = await signGithubToken();
const sender = join(import.meta.dir, "fixtures/sender");
const log = (_line: string) => {};

let server = serve();
let project: string;

function serve() {
  return Bun.serve({ port: 0, fetch: (request) => app.handle(request) });
}

function env() {
  return { TYPEDHOOK_REGISTRY_URL: server.url.href, TYPEDHOOK_OIDC_TOKEN: token };
}

function read(path: string) {
  return readFile(join(project, path), "utf8");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await read(path));
}

function pushBilling(version: string, log = (_line: string) => {}) {
  return push({
    name: "billing",
    title: "Billing",
    version,
    owner: "acme",
    cwd: sender,
    env: env(),
    log,
  });
}

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), "webhooks-cli-"));
  await writeFile(join(project, "package.json"), '{\n  "name": "app",\n  "scripts": { "build": "tsc" }\n}\n');
});

afterAll(async () => {
  server.stop(true);
  await rm(project, { recursive: true, force: true });
});

describe("webhooks CLI against the registry", () => {
  test("push uploads the events as an OpenAPI document", async () => {
    const lines: string[] = [];
    await pushBilling("1.0.0", (line) => lines.push(line));
    expect(lines).toEqual([expect.stringMatching(/^created acme\/billing@1\.0\.0 \(sha256-/)]);
  });

  test("add writes the config, lock, generated file and postinstall", async () => {
    const lines: string[] = [];
    await add(["acme/billing"], { cwd: project, env: env(), log: (line) => lines.push(line) });
    expect(lines).toEqual([
      "added acme/billing@^1.0.0 (1.0.0) → src/webhooks/billing.ts",
      "added `typedhook pull` to the postinstall script in package.json",
      expect.stringContaining("warning: typedhook isn't in dependencies"),
      "commit typedhook.json, typedhook.lock and src/webhooks so installs work offline",
    ]);

    expect(await readJson("typedhook.json")).toEqual({
      out: "src/webhooks",
      registries: { "acme/billing": "^1.0.0" },
    });
    expect(await readJson("typedhook.lock")).toEqual({
      "acme/billing": { range: "^1.0.0", version: "1.0.0", hash: expect.stringMatching(/^sha256-/) },
    });
    // The registry returns the document as pushed, in the sender's property order.
    const document = JSON.parse(JSON.stringify(billingDocument));
    const hash = await hashDocument(document);
    expect(await read("src/webhooks/billing.ts")).toBe(
      await generateTypes({ registry: "acme/billing", version: "1.0.0", hash, document }),
    );
    expect(await readJson("package.json")).toEqual({
      name: "app",
      scripts: { build: "tsc", postinstall: "typedhook pull" },
    });
  });

  test("pull works offline when the generated files match the lock", async () => {
    server.stop(true);
    const before = [await read("typedhook.lock"), await read("src/webhooks/billing.ts")];
    const lines: string[] = [];
    await pull({ cwd: join(project, "src"), env: env(), log: (line) => lines.push(line) });
    expect(lines).toEqual(["webhook types are up to date"]);
    expect([await read("typedhook.lock"), await read("src/webhooks/billing.ts")]).toEqual(before);
    await pull({ check: true, cwd: project, env: env(), log });
  });

  test("pull --check fails on an edited file", async () => {
    const path = join(project, "src/webhooks/billing.ts");
    const generated = await readFile(path, "utf8");
    await writeFile(path, generated.replace(/doc sha256-[^,]+/, "doc sha256-edited"));
    const checking = pull({ check: true, cwd: project, env: env(), log });
    await expect(checking).rejects.toThrow("src/webhooks/billing.ts doesn't match typedhook.lock");
    await writeFile(path, generated);
  });

  test("pull --check fails on a hand-edited body, and pull regenerates it", async () => {
    server = serve();
    const path = join(project, "src/webhooks/billing.ts");
    const generated = await readFile(path, "utf8");
    await writeFile(path, generated.replace("invoiceId: string;", "invoiceId: number;"));
    const checking = pull({ check: true, cwd: project, env: env(), log });
    await expect(checking).rejects.toThrow("src/webhooks/billing.ts was edited by hand");

    const lines: string[] = [];
    await pull({ cwd: project, env: env(), log: (line) => lines.push(line) });
    expect(lines).toEqual(["acme/billing@1.0.0 → src/webhooks/billing.ts"]);
    expect(await readFile(path, "utf8")).toBe(generated);
  });

  test("pull regenerates files written by another generator version", async () => {
    const path = join(project, "src/webhooks/billing.ts");
    const generated = await readFile(path, "utf8");
    await writeFile(path, generated.replace(`typedhook pull v${GENERATOR_VERSION} `, "typedhook pull v0 "));
    const checking = pull({ check: true, cwd: project, env: env(), log });
    await expect(checking).rejects.toThrow(
      `src/webhooks/billing.ts was generated by typedhook generator v0, this one is v${GENERATOR_VERSION}`,
    );

    await pull({ cwd: project, env: env(), log });
    expect(await readFile(path, "utf8")).toBe(generated);
  });

  test("pull --update moves the lock to the newest matching version", async () => {
    await pushBilling("1.1.0");
    await pull({ update: true, cwd: project, env: env(), log });
    expect(await readJson("typedhook.lock")).toEqual({
      "acme/billing": { range: "^1.0.0", version: "1.1.0", hash: expect.stringMatching(/^sha256-/) },
    });
    expect(await read("src/webhooks/billing.ts")).toStartWith(
      `// Generated by typedhook pull v${GENERATOR_VERSION} from acme/billing@1.1.0 (`,
    );
  });

  test("pull follows an edited range and drops removed registries from the lock", async () => {
    const lock = await readLock(project);
    await writeLock(project, {
      ...lock,
      "acme/gone": { range: "^1.0.0", version: "1.0.0", hash: "sha256-x" },
    });
    await writeFile(
      join(project, "typedhook.json"),
      JSON.stringify({ out: "src/webhooks", registries: { "acme/billing": "1.0.0" } }),
    );
    await expect(pull({ check: true, cwd: project, env: env(), log })).rejects.toThrow(
      "acme/gone is in typedhook.lock but not in typedhook.json",
    );

    await pull({ cwd: project, env: env(), log });
    expect(await readJson("typedhook.lock")).toEqual({
      "acme/billing": { range: "1.0.0", version: "1.0.0", hash: expect.stringMatching(/^sha256-/) },
    });
  });

  test("add rejects two registries with the same name", async () => {
    const adding = add(["other/billing"], { cwd: project, env: env(), log });
    await expect(adding).rejects.toThrow(
      "acme/billing and other/billing would both generate src/webhooks/billing.ts",
    );
  });

  test("push rejects a version the registry won't store", async () => {
    await expect(pushBilling("1.2.0\nexport const pwned = 1;")).rejects.toThrow(
      '--version must be strict semver like 1.4.0 or 2.0.0-beta.1, got "1.2.0\\nexport const pwned = 1;"',
    );
  });

  test("push says where it looked when there's no webhooks file", async () => {
    const pushing = push({ name: "billing", version: "1.0.0", out: "x.json", cwd: project, env: {}, log });
    await expect(pushing).rejects.toThrow(
      `no webhooks file in ${project}: looked for webhooks.ts (or .js) in ., src, lib, server and utils; pass --webhooks <file>`,
    );
  });

  test("push --webhooks reads the instance from the given file", async () => {
    await push({
      webhooks: join(sender, "src/webhooks.ts"),
      exportName: "wh",
      name: "billing",
      version: "2.1.0",
      out: join(project, "openapi-wh.json"),
      cwd: project,
      env: {},
      log,
    });
    expect(await readJson("openapi-wh.json")).toMatchObject({ info: { version: "2.1.0" } });
  });

  test("push --out writes the document without uploading", async () => {
    await push({
      name: "billing",
      version: "2.0.0",
      out: join(project, "openapi.json"),
      cwd: sender,
      env: {},
      log,
    });
    expect(await readJson("openapi.json")).toMatchObject({
      openapi: "3.1.0",
      info: { title: "billing", version: "2.0.0" },
    });
  });
});

test("pull fails when the registry sends another version than the locked one", async () => {
  const document = JSON.parse(canonicalJson(billingDocument));
  const hash = await hashDocument(document);
  const liar = Bun.serve({ port: 0, fetch: () => Response.json({ version: "1.1.0", hash, document }) });
  const dir = await mkdtemp(join(tmpdir(), "typedhook-liar-"));
  await writeFile(join(dir, "typedhook.json"), JSON.stringify({ registries: { "acme/billing": "^1.0.0" } }));
  await writeLock(dir, { "acme/billing": { range: "^1.0.0", version: "1.0.0", hash } });
  const pulling = pull({ cwd: dir, env: { TYPEDHOOK_REGISTRY_URL: liar.url.href }, log });
  await expect(pulling).rejects.toThrow("asked the registry for acme/billing@1.0.0, but it sent 1.1.0");
  liar.stop(true);
  await rm(dir, { recursive: true });
});

test("pull without a typedhook.json is a no-op", async () => {
  const empty = await mkdtemp(join(tmpdir(), "typedhook-empty-"));
  const lines: string[] = [];
  await pull({ cwd: empty, env: {}, log: (line) => lines.push(line) });
  expect(lines).toEqual(["typedhook: no typedhook.json found, nothing to pull"]);
  await rm(empty, { recursive: true });
});

test("the built CLI runs under node", async () => {
  const packageDir = join(import.meta.dir, "..");
  // Inside the package so node resolves @typedhook/verify from the workspace.
  const outDir = await mkdtemp(join(packageDir, ".test-dist-"));
  const build = Bun.spawnSync(
    ["bunx", "tsup", "--entry.index=src/index.ts", "--format", "esm", "--out-dir", outDir],
    { cwd: packageDir },
  );
  expect(build.exitCode).toBe(0);
  const help = Bun.spawnSync(["node", join(outDir, "index.js"), "--help"]);
  expect(help.stdout.toString()).toStartWith("Usage: typedhook <command> [options]");
  const unknown = Bun.spawnSync(["node", join(outDir, "index.js"), "nope"]);
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr.toString()).toBe('typedhook: unknown command "nope", see `typedhook --help`\n');
  await rm(outDir, { recursive: true });
}, 30_000);
