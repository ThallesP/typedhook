type AdapterStatus = "live" | "tests" | "soon";

export type AdapterGridProps = {
  adapters: { name: string; status: AdapterStatus; href: string }[];
};

const statusLabel: Record<AdapterStatus, string> = {
  live: "● live",
  tests: "● tests",
  soon: "soon",
};

export function AdapterGrid({ adapters }: AdapterGridProps) {
  return (
    <div className="not-prose mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {adapters.map((adapter) => (
        <a
          key={adapter.name}
          href={adapter.href}
          data-status={adapter.status}
          className="group flex items-center justify-between rounded-[10px] border border-line bg-panel px-3.5 py-3 text-sm text-mute transition-colors hover:border-line2 data-[status=live]:border-line2 data-[status=live]:text-ink data-[status=tests]:border-line2 data-[status=tests]:text-ink"
        >
          {adapter.name}
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-dim group-data-[status=live]:text-mint group-data-[status=tests]:text-mint">
            {statusLabel[adapter.status]}
          </span>
        </a>
      ))}
    </div>
  );
}
