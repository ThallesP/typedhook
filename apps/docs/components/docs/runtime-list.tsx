import { siBun, siCloudflareworkers, siDeno, siNodedotjs, siVercel } from "simple-icons";
import { BrandIcon } from "@/components/brand-icon";

const runtimes = [
  { name: "Node 20+", icon: siNodedotjs },
  { name: "Bun", icon: siBun },
  { name: "Deno", icon: siDeno },
  { name: "Workers", icon: siCloudflareworkers },
  { name: "Edge", icon: siVercel },
];

export function RuntimeList() {
  return (
    <div className="not-prose mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
      {runtimes.map((runtime) => (
        <div
          key={runtime.name}
          className="flex items-center gap-[9px] rounded-[10px] border border-line bg-panel p-3 text-[13.5px] text-ink2"
        >
          <BrandIcon icon={runtime.icon} className="size-4 opacity-90" />
          {runtime.name}
        </div>
      ))}
    </div>
  );
}
