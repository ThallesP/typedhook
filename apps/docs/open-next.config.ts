import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// Every page is prerendered at build time, so the cache only has to read what the build wrote.
export default defineCloudflareConfig({ incrementalCache: staticAssetsIncrementalCache });
