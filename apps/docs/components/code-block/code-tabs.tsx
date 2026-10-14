"use client";

import { CodeBlockTabs, CodeBlockTabsList, CodeBlockTabsTrigger } from "fumadocs-ui/components/codeblock";
import { type ComponentProps, createContext } from "react";
import { type SimpleIcon, siCloudflareworkers, siExpress, siHono, siNextdotjs } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";

export const CodeTabsContext = createContext(false);

const tabIcons: Partial<Record<string, SimpleIcon>> = {
  "Next.js": siNextdotjs,
  Hono: siHono,
  Workers: siCloudflareworkers,
  Express: siExpress,
};

export function CodeTabs({ children, ...props }: ComponentProps<typeof CodeBlockTabs>) {
  return (
    <CodeTabsContext value={true}>
      <CodeBlockTabs
        {...props}
        className="not-prose relative my-4 overflow-hidden rounded-xl border border-line2 bg-code"
      >
        {children}
      </CodeBlockTabs>
    </CodeTabsContext>
  );
}

export function CodeTabsList({ children, ...props }: ComponentProps<typeof CodeBlockTabsList>) {
  return (
    <CodeBlockTabsList
      {...props}
      className="h-[38px] gap-[18px] border-b border-line px-3 pe-12 font-mono text-dim md:h-[42px] md:px-3.5"
    >
      {children}
    </CodeBlockTabsList>
  );
}

export function CodeTabsTrigger({ children, value, ...props }: ComponentProps<typeof CodeBlockTabsTrigger>) {
  const icon = tabIcons[String(value)];

  return (
    <CodeBlockTabsTrigger
      {...props}
      value={value}
      className="h-full gap-[7px] px-0 py-0 font-mono text-xs font-medium hover:text-ink2 md:text-[12.5px] [&_svg]:size-3 [&>div]:inset-x-0"
    >
      {icon && <BrandIcon icon={icon} />}
      {children}
    </CodeBlockTabsTrigger>
  );
}
