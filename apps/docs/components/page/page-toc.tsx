"use client";

import { TOCItem } from "fumadocs-core/toc";
import { TOCScrollArea, useTOCItems } from "fumadocs-ui/components/toc";
import type { TOCProps } from "fumadocs-ui/layouts/notebook/page/slots/toc";
import { Text } from "lucide-react";

export function PageToc({ footer }: TOCProps) {
  const items = useTOCItems();

  return (
    <div
      id="nd-toc"
      className="sticky top-(--fd-docs-row-3) flex h-[calc(var(--fd-docs-height)-var(--fd-docs-row-3))] w-(--fd-toc-width) flex-col pb-2 pe-6 ps-2 pt-12 [grid-area:toc] max-xl:hidden xl:layout:[--fd-toc-width:248px]"
    >
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium text-mute">
        <Text className="size-3.5" />
        On this page
      </h3>
      <TOCScrollArea>
        {items.map((item) => (
          <TOCItem
            key={item.url}
            href={item.url}
            style={{ paddingInlineStart: (item.depth - 2) * 12 }}
            className="block py-1 text-[13.5px] leading-normal text-dim transition-colors hover:text-ink2 data-[active=true]:font-medium data-[active=true]:text-ink"
          >
            {item.title}
          </TOCItem>
        ))}
      </TOCScrollArea>
      {footer}
    </div>
  );
}
