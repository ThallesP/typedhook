import { SquarePen } from "lucide-react";

export type PageMetaProps = {
  sourceUrl: string;
  lastModified?: Date;
};

export function PageMeta({ sourceUrl, lastModified }: PageMetaProps) {
  return (
    <div className="mt-10 flex justify-between gap-4 border-t border-line pt-[22px] text-[13px] text-dim">
      <a href={sourceUrl} className="flex items-center gap-1.5 text-mute transition-colors hover:text-ink">
        <SquarePen className="size-3.5" />
        Edit on GitHub
      </a>
      {lastModified && (
        <span>Last updated on {lastModified.toLocaleDateString("en-US", { dateStyle: "long" })}</span>
      )}
    </div>
  );
}
