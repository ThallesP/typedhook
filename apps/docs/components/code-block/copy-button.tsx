"use client";

import { Check, Copy } from "lucide-react";
import { type RefObject, useState } from "react";

export type CopyButtonProps = {
  targetRef: RefObject<HTMLPreElement | null>;
  className?: string;
};

export function CopyButton({ targetRef, className = "" }: CopyButtonProps) {
  const [isCopied, setIsCopied] = useState(false);

  async function handleCopy() {
    const code = targetRef.current?.textContent;
    if (!code) return;
    await navigator.clipboard.writeText(code);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 1_500);
  }

  return (
    <button
      type="button"
      aria-label={isCopied ? "Copied" : "Copy code"}
      onClick={handleCopy}
      className={`grid size-7 place-items-center rounded-md text-dim transition-colors hover:bg-[#17171B] hover:text-ink2 ${className}`}
    >
      {isCopied ? <Check className="size-3.5 text-mint" /> : <Copy className="size-3.5" />}
    </button>
  );
}
