const COMPONENT_REF = "#/components/schemas/";

/** `$ref` to a component schema. Names may hold `/` (event `a/b`, def `x/y`), escaped per RFC 6901. */
export function componentRef(name: string): string {
  return `${COMPONENT_REF}${escapePointerToken(name)}`;
}

/** The component schema a `$ref` points at, or null when it points elsewhere, including inside a component. */
export function componentName(ref: string): string | null {
  if (!ref.startsWith(COMPONENT_REF)) return null;
  const token = ref.slice(COMPONENT_REF.length);
  if (token.includes("/")) return null;
  return unescapePointerToken(token);
}

function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

// `~1` first, so `~01` becomes `~1` rather than `/`.
export function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}
