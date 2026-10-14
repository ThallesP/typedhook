import { AgentActions } from "./agent-actions";

export function Hero() {
  return (
    <section className="grid-glow relative overflow-hidden border-b border-line px-4 pb-20 pt-20 text-center md:px-10 md:pb-24 md:pt-[112px]">
      <h1 className="font-display text-[34px] font-medium leading-[1.05] tracking-[-0.05em] text-[#F4F4F5] [font-stretch:87.5%] md:text-[76px]">
        Type-safe webhooks
        <br />
        <span className="text-mute">for TypeScript</span>
      </h1>
      <p className="mx-auto mt-[22px] max-w-[560px] text-base text-mute md:text-lg">
        Send, store and verify webhooks. Typed from the schema you send to the payload your customers receive.
      </p>
      <AgentActions />
    </section>
  );
}
