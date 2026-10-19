import { type Html, html } from "./html";

export type CodeLang = "typescript" | "python" | "go" | "json";

type Grammar = { pattern: RegExp; keywords: Set<string>; types: Set<string> };

type TokenKind = "comment" | "key" | "string" | "number" | "keyword" | "type" | "constant" | "function";

/** Past this many characters code is shown plain, so a huge document can't make the page slow to build. */
const MAX_HIGHLIGHT_LENGTH = 200_000;

const NEVER = "(?!)";
const SLASH_COMMENT = String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`;
// Closing quotes are optional so an unterminated string ends the scan instead of backtracking.
const DOUBLE_QUOTED = String.raw`"(?:[^"\\\n]|\\.)*"?`;
const SINGLE_QUOTED = String.raw`'(?:[^'\\\n]|\\.)*'?`;
const NUMBER = String.raw`\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b`;
const WORD = String.raw`[A-Za-z_$][\w$]*`;

const tokenClass: Record<TokenKind, string> = {
  comment: "t-comment",
  key: "t-key",
  string: "t-string",
  number: "t-number",
  keyword: "t-keyword",
  type: "t-type",
  constant: "t-number",
  function: "t-function",
};

const grammars: Record<CodeLang, Grammar> = {
  typescript: grammar({
    comment: SLASH_COMMENT,
    string: [DOUBLE_QUOTED, SINGLE_QUOTED, String.raw`\x60(?:[^\x60\\]|\\[\s\S])*(?:\x60|$)`].join("|"),
    keywords:
      "import export from type const let function return async await if new interface extends keyof typeof as readonly true false",
    types: "string number boolean null undefined unknown never void bigint Record",
  }),
  python: grammar({
    comment: "#[^\\n]*",
    string: [String.raw`"""[\s\S]*?(?:"""|$)`, String.raw`'''[\s\S]*?(?:'''|$)`, DOUBLE_QUOTED, SINGLE_QUOTED].join("|"),
    keywords:
      "from import class def return if elif else async await pass for in not and or is with as lambda raise try except True False",
    types: "str int float bool bytes None dict list",
  }),
  go: grammar({
    comment: SLASH_COMMENT,
    string: [DOUBLE_QUOTED, String.raw`\x60[^\x60]*(?:\x60|$)`, SINGLE_QUOTED].join("|"),
    keywords:
      "package import type struct func return if else var const map interface for range nil true false switch case default defer go chan select",
    types: "string int int32 int64 uint float32 float64 bool byte rune any error",
  }),
  json: grammar({
    comment: NEVER,
    key: String.raw`"(?:[^"\\\n]|\\.)*"(?=\s*:)`,
    string: DOUBLE_QUOTED,
    keywords: "true false null",
    types: "",
  }),
};

/** Spans with a class per token; every token goes through `html`, so the code is escaped. */
export function highlight(code: string, lang: CodeLang): Html {
  if (code.length > MAX_HIGHLIGHT_LENGTH) return html`${code}`;
  const { pattern, keywords, types } = grammars[lang];
  const parts: Html[] = [];
  let end = 0;
  for (const match of code.matchAll(pattern)) {
    const { 0: text, index, groups = {} } = match;
    const kind = tokenKind(groups, keywords, types, code.charAt(index + text.length));
    parts.push(html`${code.slice(end, index)}`);
    parts.push(kind === null ? html`${text}` : html`<span class="${tokenClass[kind]}">${text}</span>`);
    end = index + text.length;
  }
  parts.push(html`${code.slice(end)}`);
  return html`${parts}`;
}

function tokenKind(
  { comment, key, string, number, word }: Record<string, string | undefined>,
  keywords: Set<string>,
  types: Set<string>,
  nextChar: string,
): TokenKind | null {
  if (comment !== undefined) return "comment";
  if (key !== undefined) return "key";
  if (string !== undefined) return "string";
  if (number !== undefined) return "number";
  if (word === undefined) return null;
  if (keywords.has(word)) return "keyword";
  if (types.has(word)) return "type";
  if (/^[A-Z][A-Z0-9_]+$/.test(word)) return "constant";
  if (nextChar === "(") return "function";
  return null;
}

function grammar({
  comment,
  key = NEVER,
  string,
  keywords,
  types,
}: {
  comment: string;
  key?: string;
  string: string;
  keywords: string;
  types: string;
}): Grammar {
  const pattern = new RegExp(
    `(?<comment>${comment})|(?<key>${key})|(?<string>${string})|(?<number>${NUMBER})|(?<word>${WORD})`,
    "g",
  );
  return { pattern, keywords: new Set(keywords.split(" ")), types: new Set(types.split(" ")) };
}
