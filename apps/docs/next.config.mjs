import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// Agents get a page's markdown by adding `.md` to its URL or by asking for text/markdown.
// These are rewrites rather than a proxy because Node.js proxies are experimental on Cloudflare.
const prefersMarkdown = [{ type: "header", key: "accept", value: ".*text/markdown.*" }];

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Lets the dev server be opened from another machine over Tailscale or the LAN.
  allowedDevOrigins: ["dev", "100.123.155.61", "192.168.0.197"],
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/docs.md", destination: "/llms.mdx/docs/content.md" },
        { source: "/docs/:path+.md", destination: "/llms.mdx/docs/:path+/content.md" },
        { source: "/docs", has: prefersMarkdown, destination: "/llms.mdx/docs/content.md" },
        { source: "/docs/:path+", has: prefersMarkdown, destination: "/llms.mdx/docs/:path+/content.md" },
      ],
    };
  },
  async headers() {
    return [{ source: "/docs/:path*", headers: [{ key: "Vary", value: "Accept" }] }];
  },
};

export default withMDX(config);
