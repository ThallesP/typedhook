import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { hashDocument } from "@typedhook/verify/registry";
import { generateKeyPair } from "jose";
import { createApp } from "../src/app";
import { githubVerifier } from "../src/github-oidc";
import { d1Store } from "../src/store";
import { memoryD1 } from "./d1";
import { AUDIENCE, type TokenOptions, keySet, signGithubToken as sign } from "./github-token";

const foreign = await generateKeyPair("RS256");

/** A document with one webhook per entry, each value being its payload schema. */
function openapi(events: Record<string, unknown> = { "order.paid": {} }) {
  const webhooks = Object.fromEntries(
    Object.entries(events).map(([name, schema]) => [
      name,
      { post: { requestBody: { content: { "application/json": { schema } } } } },
    ]),
  );
  return { openapi: "3.1.0", info: { title: "Acme", version: "1.0.0" }, webhooks };
}

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp({
    store: d1Store(memoryD1()),
    verifyGithubToken: githubVerifier({ audience: AUDIENCE, keySet }),
    githubDevice: null,
  });
});

async function push(
  path: string,
  body: unknown,
  {
    token,
    raw,
    headers = {},
  }: { token?: string | null; raw?: string | ReadableStream<Uint8Array>; headers?: Record<string, string> } = {},
) {
  const bearer = token === undefined ? await sign() : token;
  const allHeaders: Record<string, string> = { "content-type": "application/json", ...headers };
  if (bearer) allHeaders.authorization = `Bearer ${bearer}`;
  const response = await app.handle(
    new Request(`http://localhost/registries/${path}`, {
      method: "PUT",
      headers: allHeaders,
      body: raw ?? JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}

/** A body of `total` spaces sent in 64 KB chunks, counting how much was read. */
function spaces(total: number) {
  const chunk = new TextEncoder().encode(" ".repeat(64 * 1024));
  const counter = { read: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (counter.read >= total) return controller.close();
      counter.read += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { stream, counter };
}

async function resolve(path: string) {
  const response = await app.handle(new Request(`http://localhost/registries/${path}`));
  return { status: response.status, body: await response.json() };
}

describe("PUT /registries/:owner/:name/versions/:version", () => {
  test("creates a new version", async () => {
    const result = await push("acme/billing/versions/1.0.0", openapi());
    expect(result.status).toBe(201);
    expect(result.body).toEqual({
      status: "created",
      version: "1.0.0",
      hash: await hashDocument(openapi()),
      bump: null,
      changes: [],
    });
    expect(result.body).toMatchObject({ hash: expect.stringMatching(/^sha256-[A-Za-z0-9+/]+=*$/) });
  });

  test("same version with the same document is unchanged, whatever the key order", async () => {
    await push("acme/billing/versions/1.0.0", openapi());
    const reordered = {
      webhooks: openapi().webhooks,
      info: { version: "1.0.0", title: "Acme" },
      openapi: "3.1.0",
    };
    const result = await push("acme/billing/versions/1.0.0", reordered);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      status: "unchanged",
      version: "1.0.0",
      hash: await hashDocument(openapi()),
    });
  });

  test("same version with a different document is a conflict", async () => {
    await push("acme/billing/versions/1.0.0", openapi());
    const result = await push("acme/billing/versions/1.0.0", openapi({ "order.refunded": {} }));
    expect(result.status).toBe(409);
  });

  test("rejects a token for another owner", async () => {
    const token = await sign({
      claims: { repository_owner: "mallory", repository_owner_id: "666" },
    });
    const result = await push("acme/billing/versions/1.0.0", openapi(), { token });
    expect(result.status).toBe(403);
  });

  test("rejects the same login from another account id (renamed owner)", async () => {
    await push("acme/billing/versions/1.0.0", openapi());
    const token = await sign({ claims: { repository_owner_id: "2002" } });
    const result = await push("acme/billing/versions/1.1.0", openapi(), { token });
    expect(result.status).toBe(403);
  });

  test("rejects a new name under a renamed login taken by another account", async () => {
    await push("acme/billing/versions/1.0.0", openapi());
    const token = await sign({ claims: { repository_owner_id: "2002" } });
    const result = await push("acme/payments/versions/1.0.0", openapi(), { token });
    expect(result.status).toBe(403);
  });

  test("stores mixed-case owners and names lowercased", async () => {
    const token = await sign({
      claims: { repository_owner: "PolarSource", repository_owner_id: "3003" },
    });
    const pushed = await push("PolarSource/X/versions/1.0.0", openapi(), { token });
    expect(pushed.status).toBe(201);
    const resolved = await resolve("polarsource/x/1.0.0");
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ version: "1.0.0" });
  });

  test("compares the owner to the token case-insensitively", async () => {
    const result = await push("ACME/billing/versions/1.0.0", openapi());
    expect(result.status).toBe(201);
    expect((await resolve("acme/billing/1.0.0")).status).toBe(200);
  });

  test.each(["push", "release", "workflow_dispatch"])("accepts %s events", async (eventName) => {
    const token = await sign({ claims: { event_name: eventName } });
    const result = await push("acme/billing/versions/1.0.0", openapi(), { token });
    expect(result.status).toBe(201);
  });

  test.each([
    "pull_request",
    "pull_request_target",
    "pull_request_review",
    "issue_comment",
    "workflow_run",
  ])("rejects %s events", async (eventName) => {
    const token = await sign({ claims: { event_name: eventName } });
    const result = await push("acme/billing/versions/1.0.0", openapi(), { token });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: expect.stringContaining("push, release, workflow_dispatch"),
    });
  });

  test("requires a bearer token", async () => {
    const result = await push("acme/billing/versions/1.0.0", openapi(), { token: null });
    expect(result.status).toBe(401);
  });

  test.each<[string, TokenOptions]>([
    ["wrong audience", { audience: "https://elsewhere.test" }],
    ["wrong issuer", { issuer: "https://evil.test" }],
    ["expired", { expiresAt: Math.floor(Date.now() / 1000) - 60 }],
    ["foreign key", { key: foreign.privateKey }],
  ])("rejects a token with %s", async (_, options) => {
    const token = await sign(options);
    const result = await push("acme/billing/versions/1.0.0", openapi(), { token });
    expect(result.status).toBe(401);
  });

  test("rejects garbage tokens", async () => {
    const result = await push("acme/billing/versions/1.0.0", openapi(), { token: "not-a-jwt" });
    expect(result.status).toBe(401);
  });

  test.each(["v1.0.0", "1.0", "latest", "1.0.0.0"])("rejects non-strict semver %s", async (v) => {
    const result = await push(`acme/billing/versions/${v}`, openapi());
    expect(result.status).toBe(400);
  });

  test("rejects an invalid registry name", async () => {
    const result = await push("acme/.hidden/versions/1.0.0", openapi());
    expect(result.status).toBe(400);
  });

  test.each<[string, unknown]>([
    ["OpenAPI 3.0", { ...openapi(), openapi: "3.0.3" }],
    ["no openapi field", { webhooks: {} }],
    ["no webhooks object", { openapi: "3.1.0", paths: {} }],
    ["webhooks as an array", { openapi: "3.1.0", webhooks: [] }],
    ["a JSON array", [openapi()]],
    ["a webhook without a JSON body", { ...openapi(), webhooks: { "order.paid": { post: {} } } }],
  ])("rejects a document with %s", async (_, document) => {
    const result = await push("acme/billing/versions/1.0.0", document);
    expect(result.status).toBe(400);
  });

  test("rejects a body that isn't JSON", async () => {
    const result = await push("acme/billing/versions/1.0.0", null, { raw: "{nope" });
    expect(result.status).toBe(400);
  });

  test("rejects documents over 1 MB", async () => {
    const big = openapi({ big: { description: "x".repeat(1_000_001) } });
    const result = await push("acme/billing/versions/1.0.0", big);
    expect(result.status).toBe(413);
  });

  test("rejects documents whose canonical form is over 1 MB", async () => {
    // 1e20 is 4 bytes in the body but 21 once JSON.stringify writes it out.
    const numbers = Array.from({ length: 60_000 }, () => "1e20").join(",");
    const raw = JSON.stringify(openapi({ big: { numbers: "[]" } })).replace('"[]"', `[${numbers}]`);
    expect(raw.length).toBeLessThan(1_000_000);
    const result = await push("acme/billing/versions/1.0.0", null, { raw });
    expect(result.status).toBe(413);
  });

  test("stops reading a streamed body once it passes 1 MB", async () => {
    const total = 10_000_000;
    const { stream, counter } = spaces(total);
    const result = await push("acme/billing/versions/1.0.0", null, { raw: stream });
    expect(result.status).toBe(413);
    expect(counter.read).toBeGreaterThan(1_000_000);
    expect(counter.read).toBeLessThan(2_000_000);
  });

  test("rejects a Content-Length over 1 MB without reading the body", async () => {
    const { stream, counter } = spaces(2_000_000);
    const result = await push("acme/billing/versions/1.0.0", null, {
      raw: stream,
      headers: { "content-length": "2000000" },
    });
    expect(result.status).toBe(413);
    expect(counter.read).toBeLessThan(1_000_000);
  });

  test("rejects documents nested deeper than 256 levels", async () => {
    // A small body, but deep enough to overflow the stack when hashed.
    const depth = 100_000;
    const raw = JSON.stringify(openapi({ deep: "X" })).replace(
      '"X"',
      `${"[".repeat(depth)}${"]".repeat(depth)}`,
    );
    const result = await push("acme/billing/versions/1.0.0", null, { raw });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "document is nested deeper than 256 levels" });
  });

  test("accepts documents nested exactly 256 levels deep", async () => {
    // The document, webhooks and the webhook's post/requestBody/content/media type are the first seven levels.
    const raw = JSON.stringify(openapi({ deep: "X" })).replace(
      '"X"',
      `${"[".repeat(249)}${"]".repeat(249)}`,
    );
    const result = await push("acme/billing/versions/1.0.0", null, { raw });
    expect(result.status).toBe(201);
  });

  test("accepts a registry URL with a trailing slash", async () => {
    app = createApp({
      store: d1Store(memoryD1()),
      verifyGithubToken: githubVerifier({ audience: `${AUDIENCE}/`, keySet }),
      githubDevice: null,
    });
    const result = await push("acme/billing/versions/1.0.0", openapi());
    expect(result.status).toBe(201);
  });

  test("logs unexpected errors and hides them from the client", async () => {
    const failure = new Error("database is down");
    const store = d1Store(memoryD1());
    app = createApp({
      store: { ...store, claimOwner: () => Promise.reject(failure) },
      verifyGithubToken: githubVerifier({ audience: AUDIENCE, keySet }),
      githubDevice: null,
    });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const result = await push("acme/billing/versions/1.0.0", openapi());
    expect(logged).toHaveBeenCalledWith(failure);
    logged.mockRestore();
    expect(result).toEqual({ status: 500, body: { error: "internal error" } });
  });

  test("a rejected push doesn't claim the owner", async () => {
    await push("acme/billing/versions/1.0.0", { openapi: "3.0.0" });
    const token = await sign({ claims: { repository_owner_id: "2002" } });
    const result = await push("acme/billing/versions/1.0.0", openapi(), { token });
    expect(result.status).toBe(201);
  });
});

describe("GET /registries/:owner/:name/:range", () => {
  beforeEach(async () => {
    for (const version of ["1.0.0", "1.2.0", "1.10.0", "2.0.0", "2.1.0-beta.1"]) {
      await push(`acme/billing/versions/${version}`, openapi({ [`v${version}`]: {} }));
    }
  });

  test.each([
    ["^1.0.0", "1.10.0"],
    ["1.2.0", "1.2.0"],
    ["latest", "2.0.0"],
    ["*", "2.0.0"],
    [encodeURIComponent(">=1.0.0 <1.5.0"), "1.2.0"],
    ["~1.2", "1.2.0"],
    ["^2.0.0", "2.0.0"],
    ["2.1.0-beta.1", "2.1.0-beta.1"],
  ])("%s resolves to %s", async (range, expected) => {
    const result = await resolve(`acme/billing/${range}`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ version: expected });
  });

  test("returns the document and its hash", async () => {
    const result = await resolve("acme/billing/1.2.0");
    const document = openapi({ "v1.2.0": {} });
    expect(result.body).toEqual({
      version: "1.2.0",
      hash: await hashDocument(document),
      document,
    });
  });

  test("returns the document in the sender's property order", async () => {
    const reordered = {
      webhooks: openapi().webhooks,
      info: { version: "1.0.0", title: "Acme" },
      openapi: "3.1.0",
    };
    await push("acme/billing/versions/3.0.0", reordered);
    const result = await resolve("acme/billing/3.0.0");
    const hash = await hashDocument(openapi());
    expect(JSON.stringify(result.body)).toBe(
      JSON.stringify({ version: "3.0.0", hash, document: reordered }),
    );
  });

  test("a range without a prerelease never resolves to one", async () => {
    const result = await resolve("acme/billing/>2.0.0");
    expect(result.status).toBe(404);
  });

  test("a range naming a prerelease can resolve to one", async () => {
    const result = await resolve("acme/billing/^2.1.0-beta.0");
    expect(result.body).toMatchObject({ version: "2.1.0-beta.1" });
  });
});

describe("GET with only some versions stable", () => {
  test("^1.4.0 skips 1.5.0-beta.1 even when no stable version matches", async () => {
    for (const version of ["1.3.0", "1.5.0-beta.1"]) {
      await push(`acme/billing/versions/${version}`, openapi());
    }
    const result = await resolve("acme/billing/^1.4.0");
    expect(result.status).toBe(404);
  });

  test.each(["latest", "*"])(
    "%s falls back to a prerelease when nothing is stable",
    async (range) => {
      for (const version of ["1.0.0-alpha.1", "1.0.0-beta.1"]) {
        await push(`acme/billing/versions/${version}`, openapi());
      }
      const result = await resolve(`acme/billing/${range}`);
      expect(result.body).toMatchObject({ version: "1.0.0-beta.1" });
    },
  );

  test("404 when no version matches", async () => {
    const result = await resolve("acme/billing/^3.0.0");
    expect(result.status).toBe(404);
  });

  test("404 for an unknown registry", async () => {
    const result = await resolve("acme/unknown/^1.0.0");
    expect(result.status).toBe(404);
  });

  test("400 for an invalid range", async () => {
    const result = await resolve("acme/billing/not-a-range");
    expect(result.status).toBe(400);
  });
});

test("unknown routes return JSON 404", async () => {
  const response = await app.handle(new Request("http://localhost/nope"));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not found" });
});
