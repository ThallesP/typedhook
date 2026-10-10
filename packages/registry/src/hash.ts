import { isRecord } from "./is-record";

const encoder = new TextEncoder();

/**
 * JSON with object keys sorted (UTF-16 order) at every depth and no whitespace,
 * so the same document always hashes the same however the sender ordered it.
 * Arrays keep their order.
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

/** `sha256-<base64>` over the canonical JSON. */
export function hashDocument(document: unknown): Promise<string> {
  return hashCanonical(canonicalJson(document));
}

/** `sha256-<base64>` over JSON that is already canonical. */
export async function hashCanonical(canonical: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical));
  return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}
