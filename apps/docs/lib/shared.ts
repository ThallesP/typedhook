import { createGetUrl } from "fumadocs-core/source";
import sdkPackage from "../../../packages/sdk/package.json";

export const sdkVersion = sdkPackage.version;
export const docsRoute = "/docs";
export const docsContentRoute = "/llms.mdx/docs";
export const repoUrl = "https://github.com/ThallesP/typedhook";
export const npmUrl = "https://www.npmjs.com/package/@typedhook/sdk";

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, "content.md"];

  return { segments, url: getContentUrl(segments, page.locale) };
}

export function getPageSourceUrl(page: { path: string }) {
  return `${repoUrl}/blob/main/apps/docs/content/docs/${page.path}`;
}
