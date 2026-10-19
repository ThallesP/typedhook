import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRegistry } from "@typedhook/verify/registry";
import { createApp } from "../../registry/src/app";
import type { DevicePoll, GithubDevice } from "../../registry/src/github-device";
import { githubVerifier } from "../../registry/src/github-oidc";
import { d1Store } from "../../registry/src/store";
import { memoryD1 } from "../../registry/test/d1";
import { AUDIENCE, keySet } from "../../registry/test/github-token";
import { add } from "../src/commands/add";
import { info } from "../src/commands/info";
import { login } from "../src/commands/login";
import { logout } from "../src/commands/logout";
import { publish } from "../src/commands/publish";
import { pull } from "../src/commands/pull";
import { search } from "../src/commands/search";
import { whoami } from "../src/commands/whoami";
import { credentialsPath } from "../src/credentials";

let polls: DevicePoll[] = [];
const device: GithubDevice = {
  start: async () => ({
    deviceCode: "device-1",
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    expiresIn: 900,
    interval: 5,
  }),
  poll: async () => polls.shift() ?? { status: "expired" },
};
const app = createApp({
  store: d1Store(memoryD1()),
  verifyGithubToken: githubVerifier({ audience: AUDIENCE, keySet }),
  githubDevice: device,
});
const server = Bun.serve({ port: 0, fetch: (request) => app.handle(request) });
const registryUrl = server.url.href.replace(/\/$/, "");
const scratch = await mkdtemp(join(tmpdir(), "typedhook-publish-"));
const env = { TYPEDHOOK_REGISTRY_URL: registryUrl, XDG_CONFIG_HOME: join(scratch, "config") };
const noSleep = async () => {};

let sender: string;
let lines: string[];
const log = (line: string) => lines.push(line);

beforeEach(async () => {
  sender = await mkdtemp(join(scratch, "sender-"));
  lines = [];
});

afterAll(async () => {
  server.stop(true);
  await rm(scratch, { recursive: true, force: true });
});

async function write(path: string, text: string) {
  await mkdir(join(sender, path, ".."), { recursive: true });
  await writeFile(join(sender, path), text);
}

async function signIn() {
  polls = [
    { status: "pending", interval: 1 },
    { status: "authorized", account: { id: "42", login: "Thalles", orgs: [{ id: "7", login: "acme" }] } },
  ];
  await login({ cwd: sender, env, log, sleep: noSleep });
}

describe("login", () => {
  test("prints the code, waits for GitHub and saves the token owner-only", async () => {
    await signIn();
    expect(lines).toEqual([
      "open https://github.com/login/device and enter the code WDJB-MJHT",
      "waiting for GitHub...",
      "signed in as thalles; you can publish as thalles, acme",
    ]);
    expect((await stat(credentialsPath(env))).mode & 0o777).toBe(0o600);
    lines = [];
    await whoami({ cwd: sender, env, log });
    expect(lines).toEqual([`thalles on ${registryUrl}; you can publish as thalles, acme`]);
  });

  test("logout revokes the token", async () => {
    await signIn();
    const { token } = JSON.parse(await readFile(credentialsPath(env), "utf8"))[registryUrl];
    lines = [];
    await logout({ cwd: sender, env, log });
    expect(lines).toEqual(["signed out thalles"]);
    await expect(whoami({ cwd: sender, env: { ...env, TYPEDHOOK_TOKEN: token }, log })).rejects.toThrow("401");
  });

  test("an expired code says to try again", async () => {
    polls = [{ status: "expired" }];
    await expect(login({ cwd: sender, env, log, sleep: noSleep })).rejects.toThrow("410");
  });
});

describe("publish from any source", () => {
  test("an OpenAPI 3.1 YAML file keeps its webhooks and only the schemas they use", async () => {
    await signIn();
    await write(
      "openapi.yaml",
      [
        "openapi: 3.1.0",
        "info: { title: Acme API, description: Payments for everyone, version: 9.9.9 }",
        "paths: { /charges: { get: { responses: { '200': { description: ok } } } } }",
        "webhooks:",
        "  charge.succeeded:",
        "    post:",
        "      summary: A charge went through",
        "      requestBody: { $ref: '#/components/requestBodies/ChargeEvent' }",
        "components:",
        "  requestBodies:",
        "    ChargeEvent: { content: { application/json: { schema: { $ref: '#/components/schemas/ChargeEvent' } } } }",
        "  schemas:",
        "    ChargeEvent:",
        "      type: object",
        "      required: [type, data]",
        "      properties: { type: { const: charge.succeeded }, data: { $ref: '#/components/schemas/Charge' } }",
        "    Charge: { type: object, properties: { amount: { type: integer } } }",
        "    Unused: { type: string }",
      ].join("\n"),
    );
    await publish({ settings: { openapi: "openapi.yaml", name: "payments" }, cwd: sender, env, log });
    expect(lines.slice(3, 5)).toEqual([
      "thalles/payments 1.0.0, first version, 1 event from openapi.yaml",
      `created thalles/payments@1.0.0: ${registryUrl}/thalles/payments`,
    ]);
    const { document } = await resolveRegistry({ registryUrl, registry: "thalles/payments", range: "latest" });
    expect(document).toMatchObject({
      info: { title: "Acme API", description: "Payments for everyone", version: "1.0.0" },
      components: { schemas: { ChargeEvent: {}, Charge: {} } },
    });
    expect(Object.keys(document)).toEqual(["openapi", "info", "webhooks", "components"]);
    expect(JSON.stringify(document)).not.toContain("Unused");
  });

  test("a folder of JSON Schemas, then an auto-picked version per change", async () => {
    await signIn();
    const paid = { type: "object", properties: { type: { const: "invoice.paid" }, amount: { type: "integer" } }, required: ["type", "amount"] };
    await write("events/invoice.paid.json", JSON.stringify(paid));
    await publish({ settings: { schemas: "events", name: "invoices", owner: "acme" }, cwd: sender, env, log });
    expect(lines).toContain(`created acme/invoices@1.0.0: ${registryUrl}/acme/invoices`);

    lines = [];
    await write("events/invoice.voided.yaml", "type: object\nproperties: { type: { const: invoice.voided } }\n");
    await publish({ cwd: sender, env, log });
    expect(lines.slice(0, 3)).toEqual([
      "acme/invoices 1.0.0 → 1.1.0 (minor), 2 events from events",
      "  + invoice.voided added",
      `created acme/invoices@1.1.0: ${registryUrl}/acme/invoices`,
    ]);

    lines = [];
    await write("events/invoice.paid.json", JSON.stringify({ ...paid, required: ["type"] }));
    await expect(publish({ version: "1.2.0", cwd: sender, env, log })).rejects.toThrow(
      "1.2.0 is a minor release, but these changes since 1.1.0 need a major one (2.0.0):\n  ! invoice.paid amount is now optional",
    );
    await publish({ cwd: sender, env, log });
    expect(lines.at(-2)).toBe(`created acme/invoices@2.0.0: ${registryUrl}/acme/invoices`);
  });

  test("example payloads, a file or a folder per event", async () => {
    await signIn();
    await write("samples/user.created.json", JSON.stringify({ type: "user.created", id: "u_1", email: "a@b.co" }));
    await write("samples/user.deleted/1.json", JSON.stringify({ type: "user.deleted", id: "u_1", reason: null }));
    await write("samples/user.deleted/2.json", JSON.stringify({ type: "user.deleted", id: "u_2", reason: "spam" }));
    await publish({ settings: { examples: "samples", name: "users" }, isDryRun: true, out: "doc.json", cwd: sender, env, log });
    expect(lines.at(-1)).toBe("dry run: nothing was uploaded");
    const document = JSON.parse(await readFile(join(sender, "doc.json"), "utf8"));
    const schema = document.webhooks["user.deleted"].post.requestBody.content["application/json"].schema;
    expect(schema).toMatchObject({
      properties: { type: { type: "string" }, reason: { type: ["null", "string"] } },
      required: ["type", "id", "reason"],
      examples: [{ id: "u_1" }, { id: "u_2" }],
    });
  });

  test("tells you where events can come from when none is set", async () => {
    await expect(publish({ cwd: sender, env, log })).rejects.toThrow("tell typedhook where your events are");
    await expect(
      publish({ settings: { schemas: "a", examples: "b" }, cwd: sender, env, log }),
    ).rejects.toThrow("use one of --schemas, --examples, not several");
  });

  test("defaults the name to the package's, without its scope", async () => {
    await signIn();
    await write("package.json", JSON.stringify({ name: "@acme/Shipping-Service" }));
    await write("events/parcel.shipped.json", JSON.stringify({ type: "object" }));
    await publish({ settings: { schemas: "events" }, isDryRun: true, cwd: sender, env, log });
    expect(lines.at(-2)).toBe("thalles/shipping-service 1.0.0, first version, 1 event from events");
  });

  test("needs a sign-in to publish", async () => {
    await write("events/a.json", JSON.stringify({ type: "object" }));
    const isolated = { ...env, XDG_CONFIG_HOME: join(sender, "nobody") };
    await expect(
      publish({ settings: { schemas: "events", owner: "acme" }, cwd: sender, env: isolated, log }),
    ).rejects.toThrow("not signed in: run `npx typedhook login`");
  });
});

describe("search and info", () => {
  test("list what's published and a registry's events and versions", async () => {
    lines = [];
    await search("invoices", { cwd: sender, env, log });
    expect(lines).toEqual(["acme/invoices@2.0.0  invoices"]);
    lines = [];
    await info("acme/invoices", { cwd: sender, env, log });
    expect(lines).toEqual([
      "acme/invoices@2.0.0  invoices",
      `${registryUrl}/acme/invoices`,
      "",
      'events (named by "type"):',
      "  invoice.paid",
      "  invoice.voided",
      "",
      "versions:",
      expect.stringMatching(/^ {2}2\.0\.0 \(major\) {2}\S+ \S+ {2}by thalles$/),
      expect.stringMatching(/^ {2}1\.1\.0 \(minor\) /),
      expect.stringMatching(/^ {2}1\.0\.0 {2}/),
    ]);
  });
});

describe("one project that publishes and receives", () => {
  test("add --lang works in a typedhook.json that only has publish settings", async () => {
    await signIn();
    await write("events/a.json", JSON.stringify({ type: "object", properties: { type: { const: "a" } } }));
    await publish({ settings: { schemas: "events", name: "both" }, cwd: sender, env, log });
    await add(["thalles/both"], { lang: "python", cwd: sender, env, log });
    expect(JSON.parse(await readFile(join(sender, "typedhook.json"), "utf8"))).toEqual({
      publish: { schemas: "events", name: "both" },
      lang: "python",
      registries: { "thalles/both": "^1.0.0" },
    });
    await expect(add(["thalles/both"], { lang: "go", cwd: sender, env, log })).rejects.toThrow(
      "generates python; use one typedhook.json per language",
    );
  });
});

describe("add and pull in Python and Go", () => {
  test.each([
    ["python", "webhooks/both.py", "# Generated by typedhook pull v"],
    ["go", "webhooks/both/both.go", "// Code generated by typedhook pull v"],
  ] as const)("%s writes %s and pull --check reads it back", async (lang, path, header) => {
    const receiver = await mkdtemp(join(scratch, `receiver-${lang}-`));
    await add(["thalles/both"], { lang, cwd: receiver, env, log });
    expect(await readFile(join(receiver, path), "utf8")).toStartWith(header);
    await pull({ check: true, cwd: receiver, env, log });
    await writeFile(join(receiver, path), "edited");
    await expect(pull({ check: true, cwd: receiver, env, log })).rejects.toThrow(`${path} doesn't match typedhook.lock`);
  });
});
