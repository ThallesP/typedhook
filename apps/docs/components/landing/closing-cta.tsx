import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { repoUrl } from "@/lib/shared";

export function ClosingCta() {
  return (
    <section className="grid-glow relative overflow-hidden border-b border-line px-4 py-20 text-center md:px-10 md:py-28">
      <h2 className="font-display text-[32px] font-medium leading-[1.08] tracking-[-0.05em] text-[#F4F4F5] [font-stretch:87.5%] md:text-5xl">
        Send your first
        <br />
        <span className="text-mute">signed webhook</span>
      </h2>
      <p className="mt-4 text-mute">
        Install the sender, declare one event and call <code className="font-mono text-[13px] text-ink2">send()</code>.
        About five minutes.
      </p>
      <div className="mt-[34px] flex justify-center gap-2.5">
        <Link
          href="/docs/quickstart"
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-ink px-3.5 text-[13.5px] font-medium text-bg"
        >
          Read the quickstart
          <ArrowRight className="size-[15px]" />
        </Link>
        <a
          href={repoUrl}
          className="inline-flex h-9 items-center rounded-lg border border-line2 bg-panel px-3.5 text-[13.5px] font-medium text-ink2 transition-colors hover:text-ink"
        >
          View on GitHub
        </a>
      </div>
    </section>
  );
}
