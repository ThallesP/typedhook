export function AgentsCard() {
  return (
    <div className="mt-7 rounded-[10px] border border-line bg-panel p-3.5">
      <b className="block text-[13px] font-medium text-ink">For coding agents</b>
      <p className="mt-1 text-[12.5px] leading-normal text-mute">
        Every page is available as Markdown. Point your agent at the full docs in one file.
      </p>
      <div className="mt-2.5 flex gap-1.5">
        <a href="/llms.txt" className="rounded-[5px] border border-line2 px-[7px] py-0.5 font-mono text-[11px] font-medium text-ink2 hover:text-ink">
          llms.txt
        </a>
        <a href="/llms-full.txt" className="rounded-[5px] border border-line2 px-[7px] py-0.5 font-mono text-[11px] font-medium text-ink2 hover:text-ink">
          llms-full.txt
        </a>
      </div>
    </div>
  );
}
