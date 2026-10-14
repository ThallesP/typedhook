import Link from "next/link";
import { siGithub } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { Brand } from "@/components/layout/brand";
import { repoUrl } from "@/lib/shared";

export function LandingHeader() {
  return (
    <header className="flex h-16 items-center gap-7 border-b border-line px-4 md:px-7">
      <Brand />
      <nav className="flex gap-6 text-sm text-mute max-md:hidden">
        <Link href="/docs" className="transition-colors hover:text-ink">
          Docs
        </Link>
        <Link href="/docs/reference/webhooks" className="transition-colors hover:text-ink">
          Reference
        </Link>
        <a href={`${repoUrl}/releases`} className="transition-colors hover:text-ink">
          Changelog
        </a>
      </nav>
      <div className="ms-auto flex gap-2">
        <a
          href={repoUrl}
          aria-label="GitHub"
          className="inline-flex h-8 items-center gap-2 rounded-lg border border-line2 bg-panel px-3 text-[13px] font-medium text-ink2 transition-colors hover:text-ink max-md:px-2"
        >
          <BrandIcon icon={siGithub} className="size-[15px]" />
          <span className="max-md:hidden">GitHub</span>
        </a>
        <Link
          href="/docs"
          className="inline-flex h-8 items-center whitespace-nowrap rounded-lg bg-ink px-3 text-[13px] font-medium text-bg"
        >
          Read the docs
        </Link>
      </div>
    </header>
  );
}
