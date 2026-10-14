import { Webhook } from "lucide-react";
import { sdkVersion } from "@/lib/shared";

export function Brand() {
  return (
    <span className="flex items-center gap-2.5 font-mono text-[15px] font-medium tracking-[-0.02em] text-ink">
      <span className="grid size-[26px] place-items-center rounded-[7px] border border-line2 bg-[#17171B]">
        <Webhook className="size-[15px] text-amber" />
      </span>
      typedhook
      <span className="rounded-full border border-line2 px-2 text-[11px] leading-[18px] text-mute max-md:hidden">
        v{sdkVersion}
      </span>
    </span>
  );
}
