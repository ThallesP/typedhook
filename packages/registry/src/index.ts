import { env } from "cloudflare:workers";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { createApp } from "./app";
import { githubVerifier } from "./github-oidc";
import { d1Store } from "./store";

export default createApp({
  store: d1Store(env.DB),
  verifyGithubToken: githubVerifier({ audience: env.REGISTRY_URL }),
  adapter: CloudflareAdapter,
}).compile();
