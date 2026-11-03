import { env } from "cloudflare:workers";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { createApp } from "./app";
import { githubDevice } from "./github-device";
import { githubVerifier } from "./github-oidc";
import { d1Store } from "./store";

// Thrown at startup, so `wrangler deploy` fails instead of shipping a registry
// that only accepts tokens minted for the wrong URL.
if (!env.REGISTRY_URL) {
  throw new Error(
    "REGISTRY_URL is not set: set vars.REGISTRY_URL in wrangler.jsonc to the registry's public URL",
  );
}

const app = createApp({
  store: d1Store(env.DB),
  verifyGithubToken: githubVerifier({ audience: env.REGISTRY_URL }),
  // Without a GitHub OAuth app only GitHub Actions can publish.
  githubDevice: env.GITHUB_CLIENT_ID ? githubDevice({ clientId: env.GITHUB_CLIENT_ID }) : null,
  adapter: CloudflareAdapter,
}).compile();

export default {
  /** Pages generate code in every language, so they're kept at the edge for as long as their cache-control says. */
  async fetch(request: Request, _env: Env, context: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") return app.fetch(request);
    const cached = await caches.default.match(request);
    if (cached) return cached;
    const response = await app.fetch(request);
    const isPage = response.ok && response.headers.get("content-type")?.startsWith("text/html") === true;
    if (isPage) context.waitUntil(caches.default.put(request, response.clone()));
    return response;
  },
};
