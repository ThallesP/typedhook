import { describe, expect, test } from "bun:test";
import { githubOidcToken } from "../src/cli/github-oidc";

describe("githubOidcToken", () => {
  test("uses TYPEDHOOK_OIDC_TOKEN when set", async () => {
    const env = { TYPEDHOOK_OIDC_TOKEN: "t" };
    expect(await githubOidcToken({ audience: "https://registry.test", env })).toBe("t");
  });

  test("requests one from GitHub Actions for the registry's audience", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    async function fetchImpl(url: string, init: RequestInit) {
      calls.push({ url, init });
      return Response.json({ value: "oidc-token" });
    }
    const token = await githubOidcToken({
      audience: "https://registry.test",
      env: {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.test/token?api-version=2.0",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      },
      fetchImpl,
    });
    expect(token).toBe("oidc-token");
    expect(calls).toEqual([
      {
        url: "https://actions.test/token?api-version=2.0&audience=https%3A%2F%2Fregistry.test",
        init: { headers: { authorization: "bearer request-token" } },
      },
    ]);
  });

  test("tells the user to grant id-token: write when there's no way to get one", async () => {
    const requesting = githubOidcToken({ audience: "https://registry.test", env: {} });
    await expect(requesting).rejects.toThrow("permissions: id-token: write");
  });
});
