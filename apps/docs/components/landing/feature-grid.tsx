import type { ReactNode } from "react";

const chip = "rounded-md border border-line2 bg-[#0F0F12] px-2 py-[3px]";
const retryBarHeightsPx = [4, 6, 8, 11, 14, 18, 23, 28, 28, 28];

const features: { title: string; description: ReactNode; visual: ReactNode }[] = [
  {
    title: "Typed events",
    description: (
      <>
        Any Standard Schema library. The event name narrows <code>data</code>.
      </>
    ),
    visual: ["zod", "valibot", "arktype"].map((name) => (
      <span key={name} className={chip}>
        {name}
      </span>
    )),
  },
  {
    title: "Scoped to a subject",
    description: "Each event names the account it's for, signed into the body.",
    visual: <span className={chip}>subject: "acct_42"</span>,
  },
  {
    title: "Outbox in your transaction",
    description: "The event commits with your data, or not at all.",
    visual: ["BEGIN", "INSERT", "COMMIT"].map((step, index) => (
      <span key={step} className="flex items-center gap-1.5">
        {index > 0 && <span className="text-dim">→</span>}
        <span className={chip}>{step}</span>
      </span>
    )),
  },
  {
    title: "Retries that back off",
    description: "30s, doubling up to 1h. After 20 attempts the row is marked dead.",
    visual: (
      <span className="flex h-7 items-end gap-[3px]">
        {retryBarHeightsPx.map((heightPx, index) => (
          <i key={index} className="w-[9px] rounded-[2px] bg-[#2E2E35]" style={{ height: heightPx }} />
        ))}
        <i className="h-7 w-[9px] rounded-[2px] bg-red/50" />
      </span>
    ),
  },
  {
    title: "Verify on any runtime",
    description: "Zero dependencies. WebCrypto only. Never throws on a bad request.",
    visual: ["Node", "Bun", "Deno", "Workers"].map((runtime) => (
      <span key={runtime} className={chip}>
        {runtime}
      </span>
    )),
  },
  {
    title: "Typed for your customers",
    description: "They import your event types and get typed payloads.",
    visual: (
      <span className="rounded-md border border-line2 bg-[#141418] px-[9px] py-1 shadow-[0_8px_24px_-10px_#000]">
        <span className="text-dim">(property)</span> amountCents: <span className="text-peach">number</span>
      </span>
    ),
  },
];

export function FeatureGrid() {
  return (
    <div className="mx-auto mt-12 grid max-w-[880px] border-l border-t border-line md:grid-cols-3">
      {features.map(({ title, description, visual }, index) => (
        <div key={title} className="border-b border-r border-line px-[26px] pb-7 pt-[26px]">
          <span className="font-mono text-[11.5px] font-medium text-dim">{String(index + 1).padStart(2, "0")}</span>
          <h3 className="mt-3.5 text-base font-medium tracking-[-0.01em] text-ink">{title}</h3>
          <p className="mt-1 text-sm leading-[1.55] text-mute [&_code]:font-mono [&_code]:text-[12.5px] [&_code]:text-ink2">
            {description}
          </p>
          <div className="mt-[18px] flex min-h-[30px] flex-wrap items-center gap-1.5 font-mono text-xs text-ink2">
            {visual}
          </div>
        </div>
      ))}
    </div>
  );
}
