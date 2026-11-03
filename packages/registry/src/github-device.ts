import { isRecord } from "./is-record";

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type GithubAccount = { id: string; login: string; orgs: { id: string; login: string }[] };

export type DevicePoll =
  | { status: "pending"; interval: number }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "authorized"; account: GithubAccount };

/**
 * GitHub's OAuth device flow, run by the registry so the CLI never holds a
 * GitHub token. The token only reads who the user is and which organizations
 * they belong to, then it's dropped.
 */
export interface GithubDevice {
  start(): Promise<DeviceCode>;
  poll(deviceCode: string): Promise<DevicePoll>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// read:org lists private memberships too, so members of private orgs can publish for them.
const SCOPE = "read:org";

const headers = { accept: "application/json", "user-agent": "typedhook-registry" };

const MAX_MEMBERSHIP_PAGES = 10;

export function githubDevice({ clientId, fetchImpl = fetch }: { clientId: string; fetchImpl?: Fetch }): GithubDevice {
  async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !isRecord(body)) throw new Error(`GitHub responded ${response.status} to ${url}`);
    return body;
  }

  async function getJson(path: string, token: string): Promise<unknown> {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: { ...headers, accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`GitHub responded ${response.status} to ${path}`);
    return response.json();
  }

  async function account(token: string): Promise<GithubAccount> {
    const user = await getJson("/user", token);
    if (!isRecord(user) || typeof user.login !== "string" || typeof user.id !== "number") {
      throw new Error("GitHub sent an unexpected /user response");
    }
    return { id: String(user.id), login: user.login, orgs: await organizations(token) };
  }

  /** Orgs where the user is an admin or member; billing managers can't touch code, so they can't publish either. */
  async function organizations(token: string): Promise<GithubAccount["orgs"]> {
    const orgs: GithubAccount["orgs"] = [];
    for (let page = 1; page <= MAX_MEMBERSHIP_PAGES; page++) {
      const memberships = await getJson(`/user/memberships/orgs?state=active&per_page=100&page=${page}`, token);
      if (!Array.isArray(memberships)) throw new Error("GitHub sent an unexpected memberships response");
      for (const membership of memberships) {
        const org = isRecord(membership) ? membership.organization : undefined;
        const role = isRecord(membership) ? membership.role : undefined;
        if (!isRecord(org) || typeof org.login !== "string" || typeof org.id !== "number") continue;
        if (role === "admin" || role === "member") orgs.push({ id: String(org.id), login: org.login });
      }
      if (memberships.length < 100) break;
    }
    return orgs;
  }

  return {
    async start() {
      const body = await postForm("https://github.com/login/device/code", { client_id: clientId, scope: SCOPE });
      const { device_code, user_code, verification_uri, expires_in, interval } = body;
      if (
        typeof device_code !== "string" ||
        typeof user_code !== "string" ||
        typeof verification_uri !== "string" ||
        typeof expires_in !== "number" ||
        typeof interval !== "number"
      ) {
        throw new Error("GitHub sent an unexpected device code response");
      }
      return {
        deviceCode: device_code,
        userCode: user_code,
        verificationUri: verification_uri,
        expiresIn: expires_in,
        interval,
      };
    },

    async poll(deviceCode) {
      const body = await postForm("https://github.com/login/oauth/access_token", {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (typeof body.access_token === "string") {
        return { status: "authorized", account: await account(body.access_token) };
      }
      const interval = typeof body.interval === "number" ? body.interval : 5;
      const outcomes: Record<string, DevicePoll> = {
        authorization_pending: { status: "pending", interval },
        slow_down: { status: "pending", interval },
        expired_token: { status: "expired" },
        access_denied: { status: "denied" },
      };
      const error = typeof body.error === "string" ? body.error : "";
      const outcome = Object.hasOwn(outcomes, error) ? outcomes[error] : undefined;
      if (outcome === undefined) throw new Error(`GitHub device flow failed: ${error || "no token"}`);
      return outcome;
    },
  };
}
