import { env } from "cloudflare:workers";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { createApp } from "./app";
import { githubVerifier } from "./github-oidc";
import { d1Store } from "./store";

// Thrown at startup, so `wrangler deploy` fails instead of shipping a registry
// that only accepts tokens minted for the wrong URL.
if (!env.REGISTRY_URL) {
  throw new Error(
    "REGISTRY_URL is not set: set vars.REGISTRY_URL in wrangler.jsonc to the registry's public URL",
  );
}

export default createApp({
  store: d1Store(env.DB),
  verifyGithubToken: githubVerifier({ audience: env.REGISTRY_URL }),
  adapter: CloudflareAdapter,
}).compile();
