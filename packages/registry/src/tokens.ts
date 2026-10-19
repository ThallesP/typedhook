import { hashText } from "@typedhook/verify/registry";

/** `th_` and 32 random bytes; the prefix tells registry tokens apart from GitHub's OIDC JWTs. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return `th_${base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

/** Only this is stored, so a database leak doesn't hand out tokens. */
export function tokenHash(token: string): Promise<string> {
  return hashText(token);
}
