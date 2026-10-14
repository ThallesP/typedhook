import type { ReactNode } from "react";

export type RulesProps = {
  children: ReactNode;
};

export function Rules({ children }: RulesProps) {
  return (
    <div className="mt-4 [counter-reset:rule] [&_li]:relative [&_li]:my-0 [&_li]:border-b [&_li]:border-line [&_li]:py-[13px] [&_li]:ps-7 [&_li]:text-[14.5px] [&_li]:text-ink2 [&_li]:[counter-increment:rule] [&_li]:before:absolute [&_li]:before:left-0 [&_li]:before:top-[13px] [&_li]:before:font-mono [&_li]:before:text-xs [&_li]:before:font-medium [&_li]:before:leading-[22px] [&_li]:before:text-dim [&_li]:before:content-[counter(rule,decimal-leading-zero)] [&_li_strong]:font-medium [&_li_strong]:text-ink [&_ol]:my-0 [&_ol]:list-none [&_ol]:border-t [&_ol]:border-line [&_ol]:p-0">
      {children}
    </div>
  );
}
