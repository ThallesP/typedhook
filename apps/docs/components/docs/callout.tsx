import { CopyCheck, Info, type LucideIcon, ScanEye, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

type CalloutType = "info" | "warn";

const calloutIcons = {
  info: Info,
  warn: TriangleAlert,
  "copy-check": CopyCheck,
  "scan-eye": ScanEye,
} satisfies Record<string, LucideIcon>;

const calloutTone: Record<CalloutType, string> = {
  info: "border-line2 bg-[#0F0F12] [&>svg]:text-mute",
  warn: "border-amber/28 bg-amber/5 [&>svg]:text-amber",
};

export type CalloutProps = {
  type?: CalloutType;
  icon?: keyof typeof calloutIcons;
  children: ReactNode;
};

export function Callout({ type = "info", icon = type, children }: CalloutProps) {
  const Icon = calloutIcons[icon];

  return (
    <div
      className={`relative my-5 rounded-[10px] border py-3.5 pe-4 ps-11 text-sm text-ink2 [&_p]:my-0 [&_strong]:font-medium [&_strong]:text-ink ${calloutTone[type]}`}
    >
      <Icon className="absolute left-4 top-[17px] size-4" />
      {children}
    </div>
  );
}
