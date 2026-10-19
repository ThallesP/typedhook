import { beforeEach, describe, expect, test } from "bun:test";
import { type AppOptions, createApp } from "../src/app";
import type { DevicePoll, GithubDevice } from "../src/github-device";
import { githubVerifier } from "../src/github-oidc";
import { githubDevice } from "../src/github-device";
import { type Database, d1Store } from "../src/store";
import { memoryD1 } from "./d1";
import { AUDIENCE, keySet, signGithubToken } from "./github-token";

function document(events: Record<string, unknown>, version = "1.0.0") {
  const webhooks = Object.fromEntries(
    Object.entries(events).map(([name, data]) => [
      name,
      {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { event: { const: name }, subject: { type: ["string", "null"] }, data },
                  required: ["event", "subject", "data"],
                },
              },
            },
          },
        },
      },
    ]),
  );
  return { openapi: "3.1.0", info: { title: "Billing", version, description: "Invoices and payments" }, webhooks };
}

const paid = { type: "object", properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] };

/** GitHub's device flow, answering polls from a queue. */
function fakeDevice(polls: DevicePoll[]): GithubDevice {
  return {
    start: async () => ({
      deviceCode: "device-1",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    }),
    poll: async () => polls.shift() ?? { status: "expired" },
  };
}

const thalles: DevicePoll = {
  status: "authorized",
  account: { id: "42", login: "ThallesP", orgs: [{ id: "7", login: "Acme" }] },
};

let app: ReturnType<typeof createApp>;
let db: Database;

function makeApp(overrides: Partial<AppOptions> = {}) {
  db = memoryD1();
  app = createApp({
    store: d1Store(db),
    verifyGithubToken: githubVerifier({ audience: AUDIENCE, keySet }),
    githubDevice: fakeDevice([{ status: "pending", interval: 5 }, thalles]),
    ...overrides,
  });
}

beforeEach(() => makeApp());

async function call(method: string, path: string, { token, body }: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

async function login(): Promise<string> {
  const started = await call("POST", "/auth/device");
  expect(started.body).toMatchObject({ userCode: "ABCD-1234", deviceCode: "device-1" });
  const pending = await call("POST", "/auth/device/token", { body: { deviceCode: "device-1" } });
  expect(pending).toEqual({ status: 202, body: { status: "pending", interval: 5 } });
  const done = await call("POST", "/auth/device/token", { body: { deviceCode: "device-1" } });
  expect(done.status).toBe(200);
  expect(done.body).toMatchObject({ login: "thallesp", owners: ["thallesp", "acme"] });
  return done.body.token;
}

describe("typedhook login", () => {
  test("issues a th_ token and tells who it belongs to", async () => {
    const token = await login();
    expect(token).toMatch(/^th_[A-Za-z0-9_-]{43}$/);
    expect(await call("GET", "/auth/whoami", { token })).toEqual({
      status: 200,
      body: { login: "thallesp", owners: ["thallesp", "acme"] },
    });
  });

  test("logout revokes the token", async () => {
    const token = await login();
    expect((await call("DELETE", "/auth/token", { token })).status).toBe(204);
    expect((await call("GET", "/auth/whoami", { token })).status).toBe(401);
  });

  test("an expired or denied code is an error the CLI can show", async () => {
    makeApp({ githubDevice: fakeDevice([{ status: "denied" }, { status: "expired" }]) });
    expect(await call("POST", "/auth/device/token", { body: { deviceCode: "x" } })).toEqual({
      status: 403,
      body: { error: "access was denied on GitHub" },
    });
    expect((await call("POST", "/auth/device/token", { body: { deviceCode: "x" } })).status).toBe(410);
    expect((await call("POST", "/auth/device/token", { body: {} })).status).toBe(400);
  });

  test("a registry without a GitHub app says so", async () => {
    makeApp({ githubDevice: null });
    expect((await call("POST", "/auth/device")).status).toBe(503);
  });
});

describe("token and membership lifetimes", () => {
  test("a token ages out after 90 days", async () => {
    const token = await login();
    await db.prepare("UPDATE tokens SET created_at = datetime('now', '-91 days')").run();
    expect((await call("GET", "/auth/whoami", { token })).status).toBe(401);
  });

  test("publishing for an org needs a membership checked in the last week", async () => {
    const token = await login();
    await db.prepare("UPDATE memberships SET checked_at = datetime('now', '-8 days')").run();
    expect(await call("PUT", "/registries/acme/billing/versions/1.0.0", { token, body: document({}) })).toEqual({
      status: 403,
      body: { error: "your membership in acme was checked over a week ago; run `typedhook login` again to publish for it" },
    });
    expect((await call("PUT", "/registries/thallesp/billing/versions/1.0.0", { token, body: document({}) })).status).toBe(201);
    expect((await call("GET", "/auth/whoami", { token })).body.owners).toEqual(["thallesp"]);
  });
});

describe("githubDevice", () => {
  test("keeps admin and member orgs across pages", async () => {
    const memberships = (page: number) =>
      page === 1
        ? Array.from({ length: 100 }, (_, index) => ({
            role: index === 0 ? "billing_manager" : "member",
            organization: { id: index, login: `org${index}` },
          }))
        : [{ role: "admin", organization: { id: 500, login: "last" } }];
    const fetchImpl = async (url: string) => {
      if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "gho_x" });
      if (url.endsWith("/user")) return Response.json({ id: 42, login: "thallesp" });
      return Response.json(memberships(Number(new URL(url).searchParams.get("page"))));
    };
    const poll = await githubDevice({ clientId: "id", fetchImpl }).poll("device");
    if (poll.status !== "authorized") throw new Error(`unexpected ${poll.status}`);
    expect(poll.account.orgs).toHaveLength(100);
    expect(poll.account.orgs.map((org) => org.login)).not.toContain("org0");
    expect(poll.account.orgs.at(-1)).toEqual({ id: "500", login: "last" });
  });
});

describe("publishing with a login token", () => {
  test("publishes as the user and as their organizations", async () => {
    const token = await login();
    const mine = await call("PUT", "/registries/thallesp/billing/versions/1.0.0", { token, body: document({ "invoice.paid": paid }) });
    expect(mine).toMatchObject({ status: 201, body: { status: "created" } });
    const org = await call("PUT", "/registries/ACME/billing/versions/1.0.0", { token, body: document({ "invoice.paid": paid }) });
    expect(org.status).toBe(201);
    const info = await call("GET", "/registries/thallesp/billing");
    expect(info.body.versions[0]).toMatchObject({ version: "1.0.0", publishedBy: "thallesp" });
  });

  test("can't publish for someone else", async () => {
    const token = await login();
    const result = await call("PUT", "/registries/mallory/billing/versions/1.0.0", { token, body: document({}) });
    expect(result).toEqual({ status: 403, body: { error: "you can publish as thallesp, acme, not mallory" } });
  });

  test("an unknown th_ token is rejected", async () => {
    const result = await call("PUT", "/registries/thallesp/billing/versions/1.0.0", { token: "th_nope", body: document({}) });
    expect(result.status).toBe(401);
  });

  test("an org claimed from GitHub Actions accepts its members' tokens, and the ids must agree", async () => {
    const oidc = await signGithubToken({ claims: { repository_owner: "acme", repository_owner_id: "7" } });
    expect((await call("PUT", "/registries/acme/billing/versions/1.0.0", { token: oidc, body: document({}) })).status).toBe(201);
    const token = await login();
    expect((await call("PUT", "/registries/acme/billing/versions/1.1.0", { token, body: document({}) })).status).toBe(201);
    const impostor = await signGithubToken({ claims: { repository_owner: "acme", repository_owner_id: "8" } });
    expect((await call("PUT", "/registries/acme/billing/versions/1.2.0", { token: impostor, body: document({}) })).status).toBe(403);
  });
});

describe("listing, changes and code", () => {
  async function publishHistory() {
    const token = await login();
    const voided = { type: "object", properties: { reason: { type: "string" } } };
    await call("PUT", "/registries/thallesp/billing/versions/1.0.0", { token, body: document({ "invoice.paid": paid }) });
    await call("PUT", "/registries/thallesp/billing/versions/1.1.0", {
      token,
      body: document({ "invoice.paid": paid, "invoice.voided": voided }, "1.1.0"),
    });
    await call("PUT", "/registries/thallesp/billing/versions/2.0.0", { token, body: document({ "invoice.voided": voided }, "2.0.0") });
    await call("PUT", "/registries/acme/shipping/versions/1.0.0", { token, body: { ...document({}), info: { title: "Shipping", version: "1.0.0" } } });
    return token;
  }

  test("each version records what changed since the one before", async () => {
    await publishHistory();
    const { body } = await call("GET", "/registries/thallesp/billing");
    expect(body).toMatchObject({ owner: "thallesp", name: "billing", title: "Billing", latest: "2.0.0" });
    expect(body.versions.map((version: { version: string; bump: string | null }) => [version.version, version.bump])).toEqual([
      ["2.0.0", "major"],
      ["1.1.0", "minor"],
      ["1.0.0", null],
    ]);
    expect(body.versions[0].changes).toEqual([{ bump: "major", event: "invoice.paid", path: "", message: "removed" }]);
  });

  test("an older version published later doesn't move latest back", async () => {
    const token = await publishHistory();
    await call("PUT", "/registries/thallesp/billing/versions/1.2.0", { token, body: document({ "invoice.paid": paid }, "1.2.0") });
    expect((await call("GET", "/registries/thallesp/billing")).body.latest).toBe("2.0.0");
  });

  test("searches by owner/name, title and description", async () => {
    await publishHistory();
    const names = async (q: string) =>
      (await call("GET", `/registries?q=${encodeURIComponent(q)}`)).body.registries.map(
        (row: { owner: string; name: string }) => `${row.owner}/${row.name}`,
      );
    expect(await names("")).toEqual(["acme/shipping", "thallesp/billing"].sort());
    expect(await names("payments")).toEqual(["thallesp/billing"]);
    expect(await names("acme/ship")).toEqual(["acme/shipping"]);
    expect(await names("%")).toEqual([]);
  });

  test("serves generated code for a version", async () => {
    await publishHistory();
    const response = await app.handle(new Request("http://localhost/registries/thallesp/billing/^1.0.0/code/ts"));
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const code = await response.text();
    expect(code).toStartWith("// Generated by typedhook pull v3 from thallesp/billing@1.1.0");
    expect(code).toContain("export function createBillingWebhooks");
    expect((await call("GET", "/registries/thallesp/billing/latest/code/cobol")).status).toBe(400);
  });

  test("unknown registries are 404", async () => {
    expect((await call("GET", "/registries/nobody/nothing")).status).toBe(404);
  });
});

describe("MCP", () => {
  async function rpc(method: string, params: unknown = {}) {
    return call("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method, params } });
  }

  test("initializes and lists tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    const tools = await rpc("tools/list");
    expect(tools.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "search_registries",
      "get_registry",
      "get_event",
      "generate_code",
    ]);
    const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
    expect((await call("POST", "/mcp", { body: notification })).status).toBe(202);
  });

  test("answers questions about a registry", async () => {
    const token = await login();
    await call("PUT", "/registries/thallesp/billing/versions/1.0.0", { token, body: document({ "invoice.paid": paid }) });
    const text = async (name: string, args: Record<string, unknown>) =>
      (await rpc("tools/call", { name, arguments: args })).body.result.content[0].text;
    expect(await text("search_registries", { query: "bill" })).toBe(
      "thallesp/billing@1.0.0: Billing. Invoices and payments",
    );
    expect(await text("get_registry", { registry: "thallesp/billing" })).toContain('Payloads name their event in the "event" field.');
    await call("PUT", "/registries/thallesp/billing/versions/1.1.0", {
      token,
      body: document({ "invoice.paid": paid, "invoice.sent": paid }, "1.1.0"),
    });
    expect(await text("get_registry", { registry: "thallesp/billing" })).toMatch(/Versions:\n- 1\.1\.0 \(minor\) .+\n- 1\.0\.0 /);
    expect(JSON.parse(await text("get_event", { registry: "thallesp/billing", event: "invoice.paid" }))).toMatchObject({
      event: "invoice.paid",
    });
    expect(await text("generate_code", { registry: "thallesp/billing", lang: "typescript" })).toContain("BillingEventMap");
    const missing = await rpc("tools/call", { name: "get_registry", arguments: { registry: "nobody/nothing" } });
    expect(missing.body.result).toEqual({ content: [{ type: "text", text: "nobody/nothing not found" }], isError: true });
  });

  test("rejects what isn't JSON-RPC", async () => {
    expect((await call("POST", "/mcp", { body: [1] })).status).toBe(400);
    expect((await rpc("nope")).body.error.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "nope" })).body.error.code).toBe(-32602);
  });
});

describe("pages", () => {
  test("serve HTML with a strict CSP, without shadowing the API", async () => {
    const token = await login();
    await call("PUT", "/registries/thallesp/billing/versions/1.0.0", { token, body: document({ "invoice.paid": paid }) });
    const home = await app.handle(new Request("http://localhost/?q=bill"));
    expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(home.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await home.text()).toContain("thallesp/billing");
    const page = await app.handle(new Request("http://localhost/thallesp/billing?version=9.9.9"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("invoice.paid");
    expect((await app.handle(new Request("http://localhost/nobody/nothing"))).status).toBe(404);
    expect((await call("GET", "/auth/whoami")).status).toBe(401);
  });
});

describe("what anonymous readers see", () => {
  test("a private repository's name isn't shown as the publisher", async () => {
    const privateRepo = await signGithubToken({ claims: { repository_owner: "acme", repository_owner_id: "7" } });
    await call("PUT", "/registries/acme/billing/versions/1.0.0", { token: privateRepo, body: document({}) });
    const publicRepo = await signGithubToken({
      claims: { repository_owner: "acme", repository_owner_id: "7", repository: "acme/sdk", repository_visibility: "public" },
    });
    await call("PUT", "/registries/acme/billing/versions/1.1.0", { token: publicRepo, body: document({}, "1.1.0") });
    const { body } = await call("GET", "/registries/acme/billing");
    expect(body.versions.map((version: { publishedBy: string }) => version.publishedBy)).toEqual([
      "acme/sdk (GitHub Actions)",
      "acme (GitHub Actions)",
    ]);
  });

  test("versions stored before documents were checked don't break publishing or the code endpoint", async () => {
    await db
      .prepare("INSERT INTO owners (login, owner_id) VALUES ('acme', '7')")
      .run();
    await db
      .prepare(
        "INSERT INTO versions (owner, name, version, hash, document) VALUES ('acme', 'legacy', '1.0.0', 'sha256-x', ?)",
      )
      .bind(JSON.stringify({ openapi: "3.1.0", info: { title: "x", version: "1.0.0" }, webhooks: { a: {} } }))
      .run();
    expect((await call("GET", "/registries/acme/legacy/latest/code/ts")).status).toBe(422);
    const oidc = await signGithubToken({ claims: { repository_owner: "acme", repository_owner_id: "7" } });
    const result = await call("PUT", "/registries/acme/legacy/versions/1.1.0", { token: oidc, body: document({}, "1.1.0") });
    expect(result).toMatchObject({ status: 201, body: { bump: null } });
  });
});
