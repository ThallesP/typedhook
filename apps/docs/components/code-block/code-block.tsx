"use client";

import { type ComponentProps, use, useRef } from "react";
import { CodeTabsContext } from "./code-tabs";
import { CopyButton } from "./copy-button";

export type CodeBlockProps = ComponentProps<"pre"> & {
  title?: string;
};

export function CodeBlock({ title, children, className = "", ...props }: CodeBlockProps) {
  const isInTabs = use(CodeTabsContext);
  const preRef = useRef<HTMLPreElement>(null);

  const code = (
    <div className="overflow-x-auto">
      <pre
        {...props}
        ref={preRef}
        className={`${className} m-0 w-max min-w-full py-4 font-mono text-xs leading-[1.7] [--padding-left:14px] [--padding-right:14px] md:py-[18px] md:text-[13.5px] md:leading-[1.75] md:[--padding-left:20px] md:[--padding-right:20px] [&>code]:flex [&>code]:flex-col`}
      >
        {children}
      </pre>
    </div>
  );

  if (isInTabs) {
    return (
      <>
        {code}
        <CopyButton targetRef={preRef} className="absolute right-2.5 top-[7px]" />
      </>
    );
  }

  return (
    <figure className="not-prose relative my-4 overflow-hidden rounded-xl border border-line2 bg-code">
      {title && (
        <div className="flex h-[38px] items-center border-b border-line px-3 md:h-[42px] md:px-3.5">
          <span className="flex h-full items-center font-mono text-xs font-medium text-ink shadow-[inset_0_-1px_0_var(--color-ink)] md:text-[12.5px]">
            {title}
          </span>
          <CopyButton targetRef={preRef} className="-me-1.5 ms-auto" />
        </div>
      )}
      {!title && <CopyButton targetRef={preRef} className="absolute right-2.5 top-2.5 z-10" />}
      {code}
    </figure>
  );
}
