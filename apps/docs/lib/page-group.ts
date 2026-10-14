import type * as PageTree from "fumadocs-core/page-tree";

export function getPageGroup(tree: PageTree.Root, pageUrl: string): string | undefined {
  let group: string | undefined;
  for (const node of tree.children) {
    if (node.type === "separator" && typeof node.name === "string") group = node.name;
    if (node.type === "page" && node.url.split("#")[0] === pageUrl) return group;
  }
  return undefined;
}
