"use client";

import { useState } from "react";

export function useCopied() {
  const [isCopied, setIsCopied] = useState(false);

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 1_500);
  }

  return { isCopied, copy };
}
