"use client";

import { usePathname } from "fumadocs-core/framework";
import Link from "fumadocs-core/link";
import { useNotebookLayout } from "fumadocs-ui/layouts/notebook";
import { Menu } from "lucide-react";
import { siGithub, siNpm } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { npmUrl, repoUrl } from "@/lib/shared";

type Section = "docs" | "reference" | "changelog";

const topLinks: { text: string; url: string; section: Section }[] = [
  { text: "Docs", url: "/docs", section: "docs" },
  { text: "Reference", url: "/docs/reference/webhooks", section: "reference" },
  { text: "Changelog", url: `${repoUrl}/releases`, section: "changelog" },
];

const iconButton =
  "grid size-[34px] place-items-center rounded-lg border border-line2 text-ink2 transition-colors hover:bg-panel hover:text-ink";

export function Header() {
  const { slots } = useNotebookLayout();
  const pathname = usePathname();
  const currentSection: Section = pathname.startsWith("/docs/reference") ? "reference" : "docs";

  return (
    <header
      id="nd-subnav"
      className="sticky top-(--fd-docs-row-1) z-10 border-b border-line bg-bg/90 backdrop-blur-sm [grid-area:header] layout:[--fd-header-height:56px] md:layout:[--fd-header-height:60px]"
    >
      <div className="flex h-14 items-center gap-2.5 px-4 md:h-[60px] md:gap-4 md:px-6">
        <slots.navTitle className="flex md:w-[248px]" />
        <nav className="flex gap-[22px] text-sm text-mute max-lg:hidden">
          {topLinks.map((link) => (
            <Link
              key={link.url}
              href={link.url}
              data-active={link.section === currentSection}
              className="transition-colors hover:text-ink data-[active=true]:text-ink"
            >
              {link.text}
            </Link>
          ))}
        </nav>
        {slots.searchTrigger && (
          <slots.searchTrigger.full hideIfDisabled className="ms-auto w-[280px] max-md:hidden" />
        )}
        <a href={repoUrl} aria-label="GitHub" className={`${iconButton} max-md:hidden`}>
          <BrandIcon icon={siGithub} className="size-4" />
        </a>
        <a href={npmUrl} aria-label="npm" className={`${iconButton} max-md:hidden`}>
          <BrandIcon icon={siNpm} className="size-4" />
        </a>
        {slots.searchTrigger && (
          <slots.searchTrigger.sm hideIfDisabled className={`${iconButton} ms-auto md:hidden`} />
        )}
        <slots.sidebar.trigger aria-label="Open menu" className={`${iconButton} md:hidden`}>
          <Menu className="size-4" />
        </slots.sidebar.trigger>
      </div>
    </header>
  );
}
