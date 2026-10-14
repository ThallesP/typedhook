import { highlight } from "fumadocs-core/highlight";
import { codeTheme } from "@/lib/code-theme";

export type WireRequestProps = {
  label: string;
  url: string;
  status: string;
  headers: Record<string, string>;
  body: string;
};

export async function WireRequest({ label, url, status, headers, body }: WireRequestProps) {
  const highlightedBody = await highlight(body, {
    lang: "json",
    themes: { light: codeTheme, dark: codeTheme },
  });

  return (
    <div className="not-prose">
      <p className="mt-5 font-mono text-[11.5px] font-medium uppercase tracking-[0.08em] text-dim">{label}</p>
      <div className="mt-3 overflow-hidden rounded-xl border border-line bg-[#0B0B0E]">
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-[11px] font-mono text-xs font-medium text-mute">
          <span className="rounded bg-amber px-1.5 font-semibold text-bg">POST</span>
          <span className="truncate">{url}</span>
          <span className="ms-auto shrink-0 text-mint">● {status}</span>
        </div>
        <table className="w-full border-collapse font-mono text-[12.5px] leading-[1.6]">
          <tbody>
            {Object.entries(headers).map(([name, value]) => (
              <tr key={name} className="border-b border-[#18181C]">
                <td className="w-[170px] px-4 py-[7px] align-top text-dim max-sm:w-[130px]">{name}</td>
                <td className="break-all px-4 py-[7px] text-ink2">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-[1.7] [&_pre]:m-0">
          {highlightedBody}
        </div>
      </div>
    </div>
  );
}
