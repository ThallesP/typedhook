import { type Html, html } from "./html";

export type Tab = { label: string; panel: Html };

/**
 * Tabs without JavaScript: one radio per tab ahead of the list, and the CSS
 * shows the panel whose radio is `:checked`. Arrow keys switch them too.
 */
export function tabs(group: string, items: Tab[]): Html {
  const [first] = items;
  if (items.length === 1 && first !== undefined) return titledFrame(first.label, first.panel);
  // Event anchors never contain `:`, so these ids can't collide with them.
  const ids = items.map((_, index) => `tab:${group}:${index}`);
  const radios = ids.map((id, index) => html`<input type="radio" name="${group}" id="${id}"${index === 0 ? html` checked` : null}>`);
  const labels = items.map(({ label }, index) => html`<label for="${ids[index]}">${label}</label>`);
  const panels = items.map(({ panel }) => html`<div class="tab-panel">${panel}</div>`);
  return html`<div class="code-frame tabs">${radios}<div class="tab-list">${labels}</div><div class="tab-panels">${panels}</div></div>`;
}

export function titledFrame(title: string, body: Html): Html {
  return html`<div class="code-frame"><div class="code-title"><span>${title}</span></div>${body}</div>`;
}
