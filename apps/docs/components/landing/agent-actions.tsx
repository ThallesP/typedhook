"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { siClaude, siCursor, siGithubcopilot } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";
import { useCopied } from "./use-copied";

const setupPrompt = `Add typed webhooks to this project with typedhook.
Read https://typedhook.dev/llms-full.txt before writing code.
- Install @typedhook/sdk. Declare events with the schema library we already use (zod, Valibot or ArkType).
- If an event is created inside a database transaction, use outbox() with our ORM's adapter and wh.with(tx).send().
- send() never throws. Check result.ok.
- Where we receive webhooks, use @typedhook/verify and store result.id to skip duplicates.`;

const installCommand = "npm i @typedhook/sdk";

const asks = [
  "Send invoice.paid from the outbox when an invoice is paid",
  "Verify webhooks in my Next.js route and skip duplicate ids",
  "Send webhooks in the same Prisma transaction as the order",
  "Alert Slack from onDead when a webhook gives up",
];

const agentIcons = [siClaude, siCursor, siGithubcopilot];

const stacked = "grid *:[grid-area:1/1] *:transition-opacity *:duration-300";

type CopyIconProps = {
  isCopied: boolean;
  className?: string;
};

function CopyIcon({ isCopied, className = "" }: CopyIconProps) {
  return (
    <span className={`${stacked} ${className}`}>
      <Copy className={`size-[15px] ${isCopied ? "opacity-0" : ""}`} />
      <Check className={`size-[15px] text-mint ${isCopied ? "" : "opacity-0"}`} />
    </span>
  );
}

function SetupButton() {
  const { isCopied, copy } = useCopied();

  return (
    <button
      type="button"
      onClick={() => copy(setupPrompt)}
      className="inline-flex h-[46px] items-center gap-2.5 rounded-[10px] bg-ink px-[18px] text-[14.5px] font-medium text-bg"
    >
      <span className="flex">
        {agentIcons.map((icon) => (
          <span
            key={icon.slug}
            className="-ms-1.5 grid size-[22px] place-items-center rounded-full border-2 border-ink bg-line2 text-ink first:ms-0"
          >
            <BrandIcon icon={icon} className="size-[11px]" />
          </span>
        ))}
      </span>
      <span className={stacked}>
        <span className={isCopied ? "opacity-0" : ""}>Copy prompt for your agent</span>
        <span className={isCopied ? "" : "opacity-0"}>Copied, paste it in</span>
      </span>
      <CopyIcon isCopied={isCopied} className="text-dim" />
    </button>
  );
}

function InstallButton() {
  const { isCopied, copy } = useCopied();

  return (
    <button
      type="button"
      onClick={() => copy(installCommand)}
      className="inline-flex h-[46px] items-center gap-2.5 rounded-[10px] border border-line2 bg-code pe-3 ps-4 font-mono text-[13.5px] text-ink2"
    >
      <span className="text-dim">$</span>
      {installCommand}
      <CopyIcon isCopied={isCopied} className="text-dim" />
    </button>
  );
}

function AskButton() {
  const [askIndex, setAskIndex] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const { isCopied, copy } = useCopied();

  useEffect(() => {
    if (isHovered) return;
    const timer = setInterval(() => setAskIndex((index) => (index + 1) % asks.length), 3_600);
    return () => clearInterval(timer);
  }, [isHovered]);

  return (
    <button
      type="button"
      onClick={() => copy(`${setupPrompt}\n\n${asks[askIndex]}`)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="group inline-flex items-center gap-2 text-left text-ink2 hover:text-ink"
    >
      <span className={stacked}>
        {asks.map((ask, index) => (
          <span
            key={ask}
            aria-hidden={index !== askIndex}
            className={`justify-self-start border-b border-dashed border-[#3A3A42] pb-px ${index === askIndex ? "" : "pointer-events-none opacity-0"}`}
          >
            {ask}
          </span>
        ))}
      </span>
      <CopyIcon
        isCopied={isCopied}
        className={`text-dim transition-opacity ${isCopied ? "" : "opacity-0 group-hover:opacity-100"}`}
      />
    </button>
  );
}

export function AgentActions() {
  return (
    <>
      <div className="mt-9 flex flex-wrap items-center justify-center gap-2.5">
        <SetupButton />
        <InstallButton />
      </div>
      <div className="mt-[22px] flex items-center justify-center gap-2.5 font-mono text-[13px] text-dim max-md:flex-col max-md:gap-1.5">
        then ask
        <AskButton />
      </div>
    </>
  );
}
