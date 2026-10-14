import type { ComponentProps } from "react";

export function OptionsTable(props: ComponentProps<"table">) {
  return (
    <div className="not-prose my-4 overflow-x-auto rounded-xl border border-line">
      <table
        {...props}
        className="w-full border-collapse text-sm [&_code]:whitespace-nowrap [&_code]:rounded-[5px] [&_code]:border [&_code]:border-line [&_code]:bg-[#17171B] [&_code]:px-[5px] [&_code]:py-px [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-ink [&_td]:border-b [&_td]:border-line [&_td]:px-4 [&_td]:py-[11px] [&_td]:align-top [&_td]:text-mute [&_td:first-child]:whitespace-nowrap [&_td:first-child_code]:text-peach [&_th]:border-b [&_th]:border-line [&_th]:bg-[#0F0F12] [&_th]:px-4 [&_th]:py-2.5 [&_th]:text-left [&_th]:font-mono [&_th]:text-[11.5px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-[0.08em] [&_th]:text-dim [&_tr:last-child_td]:border-b-0"
      />
    </div>
  );
}
