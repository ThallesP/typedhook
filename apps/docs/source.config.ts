import { defineConfig } from "fumadocs-mdx/config";
import { codeTheme } from "./lib/code-theme";

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: { light: codeTheme, dark: codeTheme },
      icon: false,
      addLanguageClass: true,
    },
    remarkNpmOptions: {
      persist: { id: "package-manager" },
      packageManagers: [
        { name: "npm", command: (command) => command },
        { name: "pnpm", command: (command) => command.replace(/^npm install\b/, "pnpm add") },
        { name: "bun", command: (command) => command.replace(/^npm install\b/, "bun add") },
      ],
    },
  },
});
