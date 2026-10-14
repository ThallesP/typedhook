import {
  DocsDescription,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/notebook/page";

export type PageHeaderProps = {
  group?: string;
  heading: string;
  description?: string;
  markdownUrl: string;
  sourceUrl: string;
};

const actionButton =
  "h-8 gap-[7px] rounded-[7px] border border-line2 bg-panel px-3 text-[13px] font-normal text-ink2 hover:bg-[#1A1A1E] hover:text-ink";

export function PageHeader({ group, heading, description, markdownUrl, sourceUrl }: PageHeaderProps) {
  const headingParts = heading.split("*");

  return (
    <div className="border-b border-line pb-[22px] md:pb-7">
      <p className="mb-3.5 flex gap-2 font-mono text-[12.5px] font-medium text-dim md:mb-[22px]">
        Docs<span>/</span>
        {group && <span className="text-mute">{group}</span>}
      </p>
      <DocsTitle className="font-display text-[34px] font-medium leading-[1.12] tracking-[-0.05em] text-balance text-[#F4F4F5] [font-stretch:87.5%] md:text-[52px] md:leading-[1.1]">
        {headingParts.map((part, index) => (
          <span key={index} className={index % 2 === 1 ? "text-mute" : undefined}>
            {part}
          </span>
        ))}
      </DocsTitle>
      <DocsDescription className="mb-0 mt-3.5 max-w-[640px] text-base leading-[1.6] text-mute md:mt-[18px] md:text-lg">
        {description}
      </DocsDescription>
      <div className="mt-5 flex gap-2 md:mt-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} className={actionButton} />
        <ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={sourceUrl} className={actionButton}>
          Open in
        </ViewOptionsPopover>
      </div>
    </div>
  );
}
