/** Markup that is already safe to emit. Only `html` and trusted constants create it. */
export class Html {
  constructor(readonly text: string) {}
}

export type Child = string | number | Html | null | undefined | false | Child[];

const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => entities[char]);
}

/**
 * Escapes every interpolated value unless it's already `Html`, so untrusted
 * strings can't open a tag or leave a quoted attribute.
 */
export function html(strings: TemplateStringsArray, ...values: Child[]): Html {
  let text = strings[0];
  values.forEach((value, index) => {
    text += render(value) + strings[index + 1];
  });
  return new Html(text);
}

function render(value: Child): string {
  if (value instanceof Html) return value.text;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(String(value));
}
