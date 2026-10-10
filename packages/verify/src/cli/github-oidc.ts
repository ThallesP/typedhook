import type { Env } from "./config";
import { isRecord } from "./is-record";
import type { FetchImpl } from "./registry-client";

export type GithubOidcTokenOptions = {
  /** The registry URL; the registry only accepts tokens issued for it. */
  audience: string;
  env: Env;
  fetchImpl?: FetchImpl;
};

/** `TYPEDHOOK_OIDC_TOKEN`, else a fresh token from the GitHub Actions runner. */
export async function githubOidcToken({
  audience,
  env,
  fetchImpl = fetch,
}: GithubOidcTokenOptions): Promise<string> {
  if (env.TYPEDHOOK_OIDC_TOKEN) return env.TYPEDHOOK_OIDC_TOKEN;
  const {
    ACTIONS_ID_TOKEN_REQUEST_URL: requestUrl,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken,
  } = env;
  if (!requestUrl || !requestToken) {
    throw new Error(
      "no OIDC token: in GitHub Actions, grant the job `permissions: id-token: write`; elsewhere set TYPEDHOOK_OIDC_TOKEN",
    );
  }

  const response = await fetchImpl(`${requestUrl}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `bearer ${requestToken}` },
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(body) || typeof body.value !== "string") {
    const reason = `${response.status} ${response.statusText}`;
    throw new Error(`GitHub Actions didn't issue an OIDC token (${reason})`);
  }
  return body.value;
}
