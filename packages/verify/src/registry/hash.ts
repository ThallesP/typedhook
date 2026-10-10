import { isRecord } from "./is-record";

const encoder = new TextEncoder();

/**
 * JSON with object keys sorted (UTF-16 order) at every depth and no whitespace.
 * Must match the registry's canonicalJson byte for byte, or every hash check fails.
 */
export function canonicalJson(value: unknown): string {
  // undefined follows JSON.stringify: dropped from objects, null in arrays. An
  // in-memory document with `description: undefined` must hash like the JSON
  // the server receives.
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

const HASH = /^sha256-[A-Za-z0-9+/]+={0,2}$/;

/** `sha256-<base64>` over the canonical JSON. */
export function hashDocument(document: unknown): Promise<string> {
  return hashText(canonicalJson(document));
}

/** `sha256-<base64>` over the UTF-8 bytes. */
export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

export function isHash(value: string): boolean {
  return HASH.test(value);
}
