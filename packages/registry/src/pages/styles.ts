import { Html } from "./html";

// Static CSS, emitted as is: escaping would break `>` selectors inside <style>.
export const styles = new Html(`
:root {
  color-scheme: dark;
  --bg: #09090b;
  --panel: #111113;
  --code: #0d0d10;
  --line: #1f1f23;
  --line2: #2a2a30;
  --ink: #ededed;
  --ink2: #c4c4ca;
  --mute: #8b8b93;
  --dim: #5a5a63;
  --heading: #f4f4f5;
  --amber: #f5b544;
  --mint: #99ffe4;
  --red: #f2a0a0;
  --peach: #ffc799;
  --sans: "Geist", system-ui, sans-serif;
  --mono: "Geist Mono", ui-monospace, monospace;
  --display: "Martian Mono", ui-monospace, monospace;
}
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--bg); scrollbar-gutter: stable; }
body { margin: 0; font: 15px/1.65 var(--sans); color: var(--ink2); -webkit-font-smoothing: antialiased; }
h1, h2, h3, p, pre, figure, ul, ol { margin: 0; }
ul, ol { padding: 0; list-style: none; }
a { color: inherit; text-decoration: none; }
button, input { font: inherit; }
code, pre { font-family: var(--mono); }
:focus-visible { outline: 2px solid var(--ink2); outline-offset: 2px; border-radius: 4px; }

.frame { display: flex; flex-direction: column; min-height: 100vh; max-width: 1120px; margin: 0 auto; border-inline: 1px solid var(--line); }
main { flex: 1; }

.site-header { display: flex; align-items: center; gap: 28px; height: 64px; padding: 0 28px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 600; letter-spacing: -0.045em; color: var(--ink); }
.brand svg { width: 26px; height: 26px; flex: none; }
.brand-tag { border: 1px solid var(--line2); border-radius: 999px; padding: 0 8px; font: 500 11px/18px var(--mono); letter-spacing: -0.02em; color: var(--mute); }
.site-nav { display: flex; gap: 24px; font-size: 14px; color: var(--mute); }
.site-nav a { transition: color 0.15s; }
.site-nav a:hover, .site-nav a[aria-current="page"] { color: var(--ink); }
.header-actions { display: flex; gap: 8px; margin-left: auto; }
.button { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border-radius: 8px; font-size: 13px; font-weight: 500; white-space: nowrap; transition: color 0.15s; }
.button svg { width: 15px; height: 15px; fill: currentColor; }
.button-primary { background: var(--ink); color: var(--bg); }
.button-secondary { border: 1px solid var(--line2); background: var(--panel); color: var(--ink2); }
.button-secondary:hover { color: var(--ink); }

.site-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px; padding: 24px 28px; border-top: 1px solid var(--line); font-size: 13px; color: var(--mute); }
.site-footer .brand { gap: 8px; font-size: 15px; color: var(--mute); }
.site-footer .brand svg { width: 22px; height: 22px; }
.site-footer nav { display: flex; gap: 20px; }
.site-footer nav a:hover { color: var(--ink); }
.license { margin-left: auto; font: 12px var(--mono); color: var(--dim); }

.display { font-family: var(--display); font-stretch: 87.5%; font-weight: 500; letter-spacing: -0.05em; color: var(--heading); }
.link { color: var(--ink); text-decoration: underline; text-decoration-color: var(--dim); text-decoration-thickness: 1px; text-underline-offset: 3px; }
.link:hover { text-decoration-color: var(--ink2); }
.inline-code { border: 1px solid var(--line); border-radius: 5px; background: #17171b; padding: 1px 5px; font-size: 13px; color: var(--ink); overflow-wrap: anywhere; }
.pill { border: 1px solid var(--line2); border-radius: 999px; padding: 0 8px; font: 500 12px/20px var(--mono); color: var(--ink2); white-space: nowrap; }

.hero { padding: 104px 40px 88px; border-bottom: 1px solid var(--line); text-align: center; }
.hero h1 { font-size: 64px; line-height: 1.05; }
.hero h1 span { color: var(--mute); }
.hero p { max-width: 540px; margin: 22px auto 0; font-size: 17px; color: var(--mute); }
.search { display: flex; gap: 8px; max-width: 520px; margin: 36px auto 0; }
.search-field { position: relative; flex: 1; }
.search-field svg { position: absolute; top: 50%; left: 14px; width: 16px; height: 16px; translate: 0 -50%; fill: none; stroke: var(--dim); stroke-width: 2; stroke-linecap: round; pointer-events: none; }
.search input { width: 100%; height: 46px; padding: 0 14px 0 40px; border: 1px solid var(--line2); border-radius: 10px; background: var(--panel); font-size: 15px; color: var(--ink); }
.search input::placeholder { color: var(--dim); }
.search input:focus { outline: none; border-color: var(--dim); }
.search input::-webkit-search-cancel-button { display: none; }
.search button { height: 46px; padding: 0 18px; border: 0; border-radius: 10px; background: var(--ink); font-size: 14.5px; font-weight: 500; color: var(--bg); cursor: pointer; }

.section { padding: 64px 56px 72px; }
.narrow { max-width: 880px; margin: 0 auto; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.section-head h2 { font-size: 20px; font-weight: 500; letter-spacing: -0.01em; color: var(--ink); overflow-wrap: anywhere; }
.count { flex: none; font: 12.5px var(--mono); color: var(--dim); }

.registry-list { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.registry-list li + li { border-top: 1px solid var(--line); }
.registry-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 24px; padding: 18px 22px; transition: background 0.15s; }
.registry-row:hover { background: var(--panel); }
.registry-id { font: 500 14.5px var(--mono); color: var(--ink); overflow-wrap: anywhere; }
.registry-id .owner { color: var(--mute); }
.registry-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; grid-row: span 2; font: 12px/20px var(--mono); color: var(--dim); }
.registry-summary { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 14px; color: var(--mute); overflow-wrap: anywhere; }
.registry-summary strong { font-weight: 500; color: var(--ink2); }

.empty { padding: 48px 24px; border: 1px dashed var(--line2); border-radius: 12px; text-align: center; }
.empty h3 { font-size: 16px; font-weight: 500; color: var(--ink); overflow-wrap: anywhere; }
.empty p { margin-top: 6px; font-size: 14px; color: var(--mute); }

.guides { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid var(--line); }
.guide { min-width: 0; padding: 44px 40px 48px; scroll-margin-top: 16px; }
.guide + .guide { border-left: 1px solid var(--line); }
.guide-step { font: 500 11.5px var(--mono); color: var(--dim); }
.guide h2 { margin-top: 14px; font-size: 18px; font-weight: 500; letter-spacing: -0.01em; color: var(--ink); }
.guide p { margin-top: 4px; font-size: 14px; line-height: 1.55; color: var(--mute); }
.terminal { margin-top: 20px; padding: 14px 16px; border: 1px solid var(--line2); border-radius: 10px; background: var(--code); font: 13px/1.8 var(--mono); color: var(--ink2); }
.command-line { padding-left: 2ch; text-indent: -2ch; white-space: pre-wrap; overflow-wrap: anywhere; }
.prompt { color: var(--dim); user-select: none; }
.command { user-select: all; }

.registry-hero { padding: 56px 56px 44px; border-bottom: 1px solid var(--line); }
.crumbs { display: flex; flex-wrap: wrap; gap: 8px; font: 500 13px var(--mono); color: var(--dim); }
.crumbs a:hover { color: var(--ink2); }
.registry-hero h1 { margin-top: 20px; font-size: 44px; line-height: 1.1; overflow-wrap: anywhere; }
.registry-hero .registry-id { margin-top: 12px; font-size: 15px; }
.lede { max-width: 680px; margin-top: 14px; font-size: 16.5px; color: var(--mute); white-space: pre-line; overflow-wrap: anywhere; }
.facts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; margin-top: 24px; font: 12.5px var(--mono); color: var(--dim); }
.facts strong { font-weight: 500; color: var(--ink2); }
.notice { max-width: 680px; margin-top: 24px; padding: 12px 16px; border: 1px solid #3b3120; border-radius: 10px; background: #14110b; font-size: 14px; color: var(--ink2); overflow-wrap: anywhere; }
.notice a { color: var(--amber); text-decoration: underline; text-decoration-color: #6b5426; text-underline-offset: 3px; }

.registry-body { display: grid; grid-template-columns: minmax(0, 1fr) 248px; }
.registry-main { min-width: 0; padding: 48px 56px 80px; }
.registry-aside { border-left: 1px solid var(--line); }
.toc { position: sticky; top: 0; max-height: 100vh; overflow-y: auto; padding: 48px 24px; }
.toc-title { font: 500 11.5px var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); }
.toc ul { display: grid; gap: 1px; margin-top: 12px; }
.toc a { display: block; padding: 3px 0; font-size: 13.5px; color: var(--mute); transition: color 0.15s; }
.toc a:hover { color: var(--ink); }
.toc .toc-event { overflow: hidden; padding-left: 12px; border-left: 1px solid var(--line); font: 12.5px var(--mono); color: var(--dim); text-overflow: ellipsis; white-space: nowrap; }
.toc .toc-event:hover { border-color: var(--dim); }

.block { scroll-margin-top: 16px; }
.block + .block { margin-top: 64px; }
.block h2 { font-size: 22px; font-weight: 500; letter-spacing: -0.02em; color: var(--heading); }
.block h2 .count { margin-left: 8px; font-size: 13px; letter-spacing: 0; }
.block-intro { margin-top: 6px; font-size: 15px; color: var(--mute); }
.usage-intro { margin-top: 24px; }

.code-frame { position: relative; margin-top: 18px; overflow: hidden; border: 1px solid var(--line2); border-radius: 12px; background: var(--code); }
.code-frame pre { overflow-x: auto; padding: 16px 20px; font: 13px/1.75 var(--mono); color: #d4d4d8; tab-size: 4; }
.code-title { display: flex; align-items: center; height: 42px; padding: 0 14px; border-bottom: 1px solid var(--line); }
.code-title span { display: flex; align-items: center; height: 100%; box-shadow: inset 0 -1px 0 var(--ink); font: 500 12.5px var(--mono); color: var(--ink); }
.scroll { max-height: 640px; overflow: auto; }
.scroll pre { overflow: visible; width: max-content; min-width: 100%; }
.install-command { padding: 16px 20px; font: 13.5px/1.75 var(--mono); color: #d4d4d8; }

.tabs > input { position: absolute; opacity: 0; pointer-events: none; }
.tab-list { display: flex; gap: 18px; height: 42px; overflow-x: auto; padding: 0 14px; border-bottom: 1px solid var(--line); }
.tab-list label { display: flex; align-items: center; font: 500 12.5px var(--mono); color: var(--dim); white-space: nowrap; cursor: pointer; transition: color 0.15s; }
.tab-list label:hover { color: var(--ink2); }
.tab-panel { display: none; }
.tabs > input:nth-of-type(1):checked ~ .tab-panels > .tab-panel:nth-child(1),
.tabs > input:nth-of-type(2):checked ~ .tab-panels > .tab-panel:nth-child(2),
.tabs > input:nth-of-type(3):checked ~ .tab-panels > .tab-panel:nth-child(3),
.tabs > input:nth-of-type(4):checked ~ .tab-panels > .tab-panel:nth-child(4) { display: block; }
.tabs > input:nth-of-type(1):checked ~ .tab-list > label:nth-child(1),
.tabs > input:nth-of-type(2):checked ~ .tab-list > label:nth-child(2),
.tabs > input:nth-of-type(3):checked ~ .tab-list > label:nth-child(3),
.tabs > input:nth-of-type(4):checked ~ .tab-list > label:nth-child(4) { box-shadow: inset 0 -1px 0 var(--ink); color: var(--ink); }
.tabs > input:nth-of-type(1):focus-visible ~ .tab-list > label:nth-child(1),
.tabs > input:nth-of-type(2):focus-visible ~ .tab-list > label:nth-child(2),
.tabs > input:nth-of-type(3):focus-visible ~ .tab-list > label:nth-child(3),
.tabs > input:nth-of-type(4):focus-visible ~ .tab-list > label:nth-child(4) { outline: 2px solid var(--ink2); outline-offset: -8px; border-radius: 6px; }

.t-comment { color: var(--dim); font-style: italic; }
.t-keyword { color: #a0a0a8; }
.t-string { color: var(--mint); }
.t-key { color: var(--ink2); }
.t-number { color: var(--red); }
.t-type { color: var(--peach); }
.t-function { color: var(--peach); }

.events { margin-top: 20px; border-top: 1px solid var(--line); }
.event { padding: 30px 0 32px; border-bottom: 1px solid var(--line); scroll-margin-top: 8px; }
.event h3 { font: 500 16px var(--mono); color: var(--ink); overflow-wrap: anywhere; }
.event h3 a { display: inline-flex; gap: 10px; }
.event h3 .hash { color: var(--dim); opacity: 0; transition: opacity 0.15s; }
.event h3 a:hover .hash, .event:target h3 .hash { opacity: 1; }
.event-key { margin-top: 4px; font: 12.5px var(--mono); color: var(--dim); overflow-wrap: anywhere; }
.event-description { max-width: 680px; margin-top: 8px; font-size: 14.5px; color: var(--mute); white-space: pre-line; overflow-wrap: anywhere; }
.event .code-frame { margin-top: 16px; }
.event .scroll { max-height: 520px; }

.versions { margin-top: 20px; border-top: 1px solid var(--line); }
.version { padding: 20px 0 22px; border-bottom: 1px solid var(--line); }
.version-current { padding-left: 16px; box-shadow: inset 2px 0 0 var(--ink2); }
.version-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.version-head > a { font: 500 14.5px var(--mono); color: var(--ink); overflow-wrap: anywhere; }
.version-head > a:hover { text-decoration: underline; text-decoration-color: var(--dim); text-underline-offset: 3px; }
.version-tag { font: 12px var(--mono); color: var(--dim); }
.version-when { margin-left: auto; font: 12.5px var(--mono); color: var(--dim); overflow-wrap: anywhere; }
.badge { padding: 0 7px; border: 1px solid; border-radius: 6px; font: 500 11.5px/19px var(--mono); }
.badge-major { border-color: #4a2b2e; background: #1a1012; color: var(--red); }
.badge-minor { border-color: #4a3a1c; background: #17120a; color: var(--amber); }
.badge-patch { border-color: #1d4339; background: #0b1614; color: var(--mint); }
.changes { display: grid; gap: 6px; margin-top: 12px; font-size: 14px; color: var(--mute); }
.change { display: flex; gap: 10px; overflow-wrap: anywhere; }
.change::before { content: ""; flex: none; width: 6px; height: 6px; margin-top: 9px; border-radius: 50%; background: var(--dim); }
.change-major::before { background: var(--red); }
.change-minor::before { background: var(--amber); }
.change-patch::before { background: var(--mint); }
.change code { font-size: 13px; color: var(--ink2); }
.change .change-path { padding: 1px 5px; border: 1px solid var(--line); border-radius: 5px; background: #141417; font-size: 12.5px; }
.version-note { margin-top: 10px; font-size: 14px; color: var(--dim); }
.more-changes { margin-top: 8px; }
.more-changes summary { font-size: 13.5px; color: var(--mute); cursor: pointer; }
.more-changes summary:hover { color: var(--ink2); }
.more-changes .changes { margin-top: 8px; }

.not-found { padding: 120px 24px 128px; text-align: center; }
.not-found-code { font: 500 13px var(--mono); color: var(--dim); }
.not-found h1 { margin-top: 14px; font-size: 48px; line-height: 1.05; }
.not-found p { max-width: 520px; margin: 16px auto 0; font-size: 16px; color: var(--mute); overflow-wrap: anywhere; }
.not-found .button { height: 36px; margin-top: 32px; padding: 0 14px; font-size: 13.5px; }

@media (max-width: 960px) {
  .registry-body { grid-template-columns: minmax(0, 1fr); }
  .registry-aside { display: none; }
}

@media (max-width: 760px) {
  body { font-size: 14.5px; }
  .frame { border-inline: 0; }
  .site-header { gap: 16px; height: 56px; padding: 0 16px; }
  .site-nav, .brand-tag, .button-label { display: none; }
  .button-secondary { padding: 0 9px; }
  .site-footer { padding: 20px 16px; }
  .hero { padding: 64px 16px 56px; }
  .hero h1 { font-size: 28px; text-wrap: balance; }
  .hero p { font-size: 15.5px; }
  .search { margin-top: 28px; }
  .search button { padding: 0 14px; }
  .section { padding: 40px 16px 48px; }
  .registry-row { grid-template-columns: minmax(0, 1fr); padding: 16px; }
  .registry-meta { flex-direction: row; align-items: center; gap: 10px; grid-row: auto; order: 1; margin-top: 6px; }
  .guides { grid-template-columns: minmax(0, 1fr); }
  .guide { padding: 36px 16px 40px; }
  .guide + .guide { border-top: 1px solid var(--line); border-left: 0; }
  .registry-hero { padding: 36px 16px 32px; }
  .registry-hero h1 { font-size: 30px; }
  .lede { font-size: 15.5px; }
  .registry-main { padding: 32px 16px 56px; }
  .block + .block { margin-top: 48px; }
  .code-frame pre, .install-command { padding: 14px 16px; font-size: 12px; }
  .scroll, .event .scroll { max-height: 420px; }
  .version-when { width: 100%; margin-left: 0; }
  .not-found { padding: 80px 20px 96px; }
  .not-found h1 { font-size: 34px; }
}
`);
