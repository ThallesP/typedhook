import { Braces, Database, type LucideIcon, Package, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

const featureIcons = {
  braces: Braces,
  database: Database,
  "shield-check": ShieldCheck,
  package: Package,
} satisfies Record<string, LucideIcon>;

export type FeatureCardsProps = {
  children: ReactNode;
};

export function FeatureCards({ children }: FeatureCardsProps) {
  return <div className="not-prose mt-4 grid gap-2.5 md:mt-[22px] md:grid-cols-2 md:gap-3">{children}</div>;
}

export type FeatureCardProps = {
  index: string;
  icon: keyof typeof featureIcons;
  title: string;
  children: ReactNode;
};

export function FeatureCard({ index, icon, title, children }: FeatureCardProps) {
  const Icon = featureIcons[icon];

  return (
    <div className="relative grid grid-cols-[34px_1fr] gap-3 rounded-xl border border-line bg-linear-to-b from-panel to-[#0C0C0F] px-4 py-3.5 md:block md:px-5 md:pb-[22px] md:pt-5">
      <span className="absolute right-5 top-5 font-mono text-[11px] font-medium text-dim max-md:hidden">{index}</span>
      <div className="grid size-[34px] place-items-center rounded-[9px] border border-line2 bg-[#16161A] md:mb-4">
        <Icon className="size-4 text-ink" />
      </div>
      <div>
        <h3 className="text-[14.5px] font-medium text-ink md:text-[15px]">{title}</h3>
        <p className="mt-0.5 text-[13.5px] leading-[1.55] text-mute md:mt-1 md:text-sm [&_code]:font-mono [&_code]:text-[12.5px] [&_code]:text-ink2">
          {children}
        </p>
      </div>
    </div>
  );
}
