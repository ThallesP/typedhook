"use client";

import type * as PageTree from "fumadocs-core/page-tree";

export type SidebarSeparatorProps = {
  item: PageTree.Separator;
};

export function SidebarSeparator({ item }: SidebarSeparatorProps) {
  return (
    <p className="mb-2 mt-[22px] px-2.5 font-mono text-[11.5px] font-medium uppercase tracking-[0.08em] text-dim first:mt-0">
      {item.name}
    </p>
  );
}
