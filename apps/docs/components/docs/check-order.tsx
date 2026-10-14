import { Fragment } from "react";

export type CheckOrderProps = {
  stages: string[];
};

export function CheckOrder({ stages }: CheckOrderProps) {
  return (
    <div className="not-prose mt-3.5 flex flex-wrap items-center gap-2 font-mono text-xs text-dim">
      {stages.map((stage, index) => (
        <Fragment key={stage}>
          {index > 0 && <span>→</span>}
          <span className="rounded-md border border-line bg-panel px-2 py-[3px] text-mute">{stage}</span>
        </Fragment>
      ))}
    </div>
  );
}
