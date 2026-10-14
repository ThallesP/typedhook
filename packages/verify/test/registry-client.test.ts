import { describe, expect, test } from "bun:test";
import { hashDocument } from "../src/registry/hash";
import { isStrictSemver, parseRegistry, pushDocument, resolveRegistry } from "../src/registry/registry-client";

const document = { openapi: "3.1.0", info: { title: "Billing", version: "1.4.0" }, webhooks: {} };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  async function fetchImpl(url: string, init: RequestInit) {
    calls.push({ url, init });
    return Response.json(body, { status });
  }
  return { calls, fetchImpl };
}

describe("resolveRegistry", () => {
  test("returns the version after checking its hash", async () => {
    const hash = await hashDocument(document);
    const { calls, fetchImpl } = fakeFetch(200, { version: "1.4.0", hash, document });
    const resolved = await resolveRegistry({
      registryUrl: "https://registry.test/",
      registry: "acme/billing",
      range: "^1.4.0",
      fetchImpl,
    });
    expect(resolved).toEqual({ version: "1.4.0", hash, document });
    expect(calls).toEqual([
      { url: "https://registry.test/registries/acme/billing/%5E1.4.0", init: { method: "GET" } },
    ]);
  });

  test("passes latest through as the range", async () => {
    const hash = await hashDocument(document);
    const { calls, fetchImpl } = fakeFetch(200, { version: "1.4.0", hash, document });
    await resolveRegistry({
      registryUrl: "https://registry.test",
      registry: "acme/billing",
      range: "latest",
      fetchImpl,
    });
    expect(calls[0]?.url).toBe("https://registry.test/registries/acme/billing/latest");
  });

  test("hashes canonically, whatever order the keys arrive in", async () => {
    const hash = await hashDocument(document);
    const reordered = { webhooks: {}, info: { version: "1.4.0", title: "Billing" }, openapi: "3.1.0" };
    const { fetchImpl } = fakeFetch(200, { version: "1.4.0", hash, document: reordered });
    const resolved = await resolveRegistry({
      registryUrl: "https://registry.test",
      registry: "acme/billing",
      range: "1.4.0",
      fetchImpl,
    });
    expect(resolved.hash).toBe(hash);
  });

  test("fails when the document doesn't match its hash", async () => {
    const hash = await hashDocument({ ...document, webhooks: { "invoice.paid": {} } });
    const { fetchImpl } = fakeFetch(200, { version: "1.4.0", hash, document });
    const resolving = resolveRegistry({
      registryUrl: "https://registry.test",
      registry: "acme/billing",
      range: "1.4.0",
      fetchImpl,
    });
    await expect(resolving).rejects.toThrow(`but the registry says ${hash}`);
  });

  test("passes the registry's error through", async () => {
    const { fetchImpl } = fakeFetch(404, { error: "no version of acme/billing matches ^2.0.0" });
    const resolving = resolveRegistry({
      registryUrl: "https://registry.test",
      registry: "acme/billing",
      range: "^2.0.0",
      fetchImpl,
    });
    await expect(resolving).rejects.toThrow("registry responded 404: no version of acme/billing matches ^2.0.0");
  });

  test("rejects a version that isn't strict semver", async () => {
    const hash = await hashDocument(document);
    const versions = ["1.4.0\nexport const pwned = 1;", "1.4.0\u2028pwned", "1.4.0\u2029pwned", "latest"];
    for (const version of versions) {
      const { fetchImpl } = fakeFetch(200, { version, hash, document });
      const resolving = resolveRegistry({
        registryUrl: "https://registry.test",
        registry: "acme/billing",
        range: "^1.4.0",
        fetchImpl,
      });
      await expect(resolving).rejects.toThrow(
        `registry sent an invalid version for acme/billing@^1.4.0: ${JSON.stringify(version)}`,
      );
    }
  });

  test("rejects an unexpected response shape", async () => {
    const { fetchImpl } = fakeFetch(200, { version: "1.4.0" });
    const resolving = resolveRegistry({
      registryUrl: "https://registry.test",
      registry: "acme/billing",
      range: "1.4.0",
      fetchImpl,
    });
    await expect(resolving).rejects.toThrow("registry sent an unexpected response for acme/billing@1.4.0");
  });
});

describe("pushDocument", () => {
  test("PUTs the document with the token", async () => {
    const { calls, fetchImpl } = fakeFetch(201, { status: "created", version: "1.4.0", hash: "sha256-x" });
    const pushed = await pushDocument({
      registryUrl: "https://registry.test",
      registry: "acme/billing",
      version: "1.4.0",
      document,
      token: "oidc-token",
      fetchImpl,
    });
    expect(pushed).toEqual({ status: "created", version: "1.4.0", hash: "sha256-x" });
    expect(calls).toEqual([
      {
        url: "https://registry.test/registries/acme/billing/versions/1.4.0",
        init: {
          method: "PUT",
          headers: { authorization: "Bearer oidc-token", "content-type": "application/json" },
          body: JSON.stringify(document),
        },
      },
    ]);
  });

  test("reports an unchanged version", async () => {
    const { fetchImpl } = fakeFetch(200, { status: "unchanged", version: "1.4.0", hash: "sha256-x" });
    const pushed = await pushDocument({
      registryUrl: "https://registry.test",
      registry: "acme/billing",
      version: "1.4.0",
      document,
      token: "t",
      fetchImpl,
    });
    expect(pushed.status).toBe("unchanged");
  });

  test("fails on a conflicting version", async () => {
    const error = "acme/billing@1.4.0 already exists with different content";
    const { fetchImpl } = fakeFetch(409, { error });
    const pushing = pushDocument({
      registryUrl: "https://registry.test",
      registry: "acme/billing",
      version: "1.4.0",
      document,
      token: "t",
      fetchImpl,
    });
    await expect(pushing).rejects.toThrow(`registry responded 409: ${error}`);
  });

  test("falls back to the status text when the body isn't JSON", async () => {
    async function fetchImpl() {
      return new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" });
    }
    const pushing = pushDocument({
      registryUrl: "https://registry.test",
      registry: "acme/billing",
      version: "1.4.0",
      document,
      token: "t",
      fetchImpl,
    });
    await expect(pushing).rejects.toThrow("registry responded 502: Bad Gateway");
  });
});

describe("isStrictSemver", () => {
  test("accepts release and prerelease versions", () => {
    const versions = ["0.0.0", "1.4.0", "10.20.30", "2.0.0-beta.1", "1.0.0-alpha-a.b-c", "1.0.0-0.3.7"];
    for (const version of versions) {
      expect(isStrictSemver(version)).toBe(true);
    }
  });

  test("rejects anything the registry won't store", () => {
    for (const version of [
      "",
      "1",
      "1.0",
      "v1.0.0",
      "01.0.0",
      "1.0.0-01",
      "1.0.0+build",
      " 1.0.0",
      "1.0.0\n",
      "1.0.0\u2028",
      "1.0.0-beta\nx",
      `1.0.0-${"a".repeat(256)}`,
    ]) {
      expect(isStrictSemver(version)).toBe(false);
    }
  });
});

describe("parseRegistry", () => {
  test("splits owner/name", () => {
    expect(parseRegistry("polarsource/polar.sh-events")).toEqual({
      owner: "polarsource",
      name: "polar.sh-events",
    });
  });

  test("rejects anything else", () => {
    for (const registry of [
      "polar",
      "a/b/c",
      "../x",
      "acme/..",
      "acme/",
      "/x",
      "acme/bill ing",
      `acme/${"x".repeat(101)}`,
    ]) {
      expect(() => parseRegistry(registry)).toThrow(`invalid registry "${registry}"`);
    }
  });
});
