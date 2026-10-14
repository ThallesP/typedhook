import { Webhook } from "lucide-react";
import Link from "next/link";
import { npmUrl, repoUrl } from "@/lib/shared";

export function LandingFooter() {
  return (
    <footer className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-6 text-[13px] text-dim md:px-7">
      <span className="flex items-center gap-2.5 font-mono text-[13.5px]">
        <span className="grid size-[22px] place-items-center rounded-[7px] border border-line2 bg-[#17171B]">
          <Webhook className="size-[13px] text-amber" />
        </span>
        typedhook
      </span>
      <nav className="flex gap-5 text-mute">
        <Link href="/docs" className="hover:text-ink">
          Docs
        </Link>
        <a href={repoUrl} className="hover:text-ink">
          GitHub
        </a>
        <a href={npmUrl} className="hover:text-ink">
          npm
        </a>
        <a href={`${repoUrl}/releases`} className="hover:text-ink">
          Changelog
        </a>
      </nav>
      <span className="ms-auto font-mono text-xs">MIT License</span>
    </footer>
  );
}
