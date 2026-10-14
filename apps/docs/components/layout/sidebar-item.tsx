"use client";

import { usePathname } from "fumadocs-core/framework";
import type * as PageTree from "fumadocs-core/page-tree";
import { SidebarItem as BaseSidebarItem } from "fumadocs-ui/components/sidebar/base";

export type SidebarItemProps = {
  item: PageTree.Item;
};

export function SidebarItem({ item }: SidebarItemProps) {
  const pathname = usePathname();
  const isReference = item.url.startsWith("/docs/reference/");
  const isComingSoon = item.url.startsWith("/docs/roadmap#");

  return (
    <BaseSidebarItem
      href={item.url}
      external={item.external}
      active={item.url === pathname}
      className={`flex items-center justify-between rounded-[7px] px-2.5 py-[5px] text-sm leading-normal text-mute transition-colors hover:text-ink data-[active=true]:bg-[#1A1A1E] data-[active=true]:font-medium data-[active=true]:text-ink ${isReference ? "font-mono text-[13px]" : ""}`}
    >
      {item.name}
      {isComingSoon && (
        <span className="rounded border border-line2 px-[5px] font-mono text-[10px] uppercase tracking-[0.06em] text-dim">
          soon
        </span>
      )}
    </BaseSidebarItem>
  );
}
