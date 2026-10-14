import type * as PageTree from "fumadocs-core/page-tree";
import Link from "next/link";

export type PagePagerProps = {
  previous?: PageTree.Item;
  next?: PageTree.Item;
};

export function PagePager({ previous, next }: PagePagerProps) {
  const hasBoth = previous !== undefined && next !== undefined;

  return (
    <nav className={`mt-14 grid gap-3 ${hasBoth ? "sm:grid-cols-2" : ""}`}>
      {previous && <PagerCard item={previous} label="Previous" showDescription={!hasBoth} />}
      {next && <PagerCard item={next} label="Next" showDescription={!hasBoth} isNext />}
    </nav>
  );
}

type PagerCardProps = {
  item: PageTree.Item;
  label: string;
  showDescription: boolean;
  isNext?: boolean;
};

function PagerCard({ item, label, showDescription, isNext = false }: PagerCardProps) {
  return (
    <Link
      href={item.url}
      className={`rounded-xl border border-line2 px-5 py-4 transition-colors hover:bg-panel ${isNext ? "text-right" : ""}`}
    >
      <small className="font-mono text-[11.5px] font-medium uppercase tracking-[0.08em] text-dim">{label}</small>
      <b className="mt-1 block text-base font-medium text-ink">{item.name}</b>
      {showDescription && item.description && (
        <p className="mt-0.5 text-[13.5px] text-mute">{item.description}</p>
      )}
    </Link>
  );
}
