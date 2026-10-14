import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export type LinkCardsProps = {
  children: ReactNode;
};

export function LinkCards({ children }: LinkCardsProps) {
  return <div className="not-prose mt-[22px] grid gap-3 sm:grid-cols-2">{children}</div>;
}

export type LinkCardProps = {
  href: string;
  title: string;
  description: string;
};

export function LinkCard({ href, title, description }: LinkCardProps) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-[10px] border border-line bg-panel px-[18px] py-4 transition-colors hover:border-line2 hover:bg-[#151518]"
    >
      <div>
        <b className="block text-[14.5px] font-medium text-ink">{title}</b>
        <span className="text-[13px] text-mute">{description}</span>
      </div>
      <ArrowUpRight className="size-4 shrink-0 text-dim" />
    </Link>
  );
}
