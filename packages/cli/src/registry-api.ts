import type { FetchImpl } from "@typedhook/verify/registry";
import { isRecord } from "./is-record";

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type DevicePoll = { status: "pending"; interval: number } | { status: "done"; token: string; login: string; owners: string[] };

export type Identity = { login: string; owners: string[] };

export type RegistryListing = {
  owner: string;
  name: string;
  title: string;
  description: string | null;
  latest: string;
  updatedAt: string;
};

export type RegistryInfo = RegistryListing & {
  versions: { version: string; createdAt: string; bump: string | null; publishedBy: string | null }[];
};

/** The registry's account and listing endpoints, for the commands that aren't pull and push. */
export function registryApi(registryUrl: string, fetchImpl: FetchImpl = fetch) {
  async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const response = await fetchImpl(`${registryUrl}${path}`, init);
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) return { status: response.status, body };
    const reason = isRecord(body) && typeof body.error === "string" ? body.error : response.statusText;
    throw new Error(`registry responded ${response.status}: ${reason}`);
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  return {
    async startDeviceLogin(): Promise<DeviceCode> {
      const { body } = await request("/auth/device", { method: "POST" });
      if (!isRecord(body) || typeof body.deviceCode !== "string" || typeof body.userCode !== "string") {
        throw new Error("registry sent an unexpected device code");
      }
      return {
        deviceCode: body.deviceCode,
        userCode: body.userCode,
        verificationUri: typeof body.verificationUri === "string" ? body.verificationUri : "https://github.com/login/device",
        expiresIn: typeof body.expiresIn === "number" ? body.expiresIn : 900,
        interval: typeof body.interval === "number" ? body.interval : 5,
      };
    },

    async pollDeviceLogin(deviceCode: string): Promise<DevicePoll> {
      const { status, body } = await request("/auth/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
      if (status === 202) return { status: "pending", interval: isRecord(body) && typeof body.interval === "number" ? body.interval : 5 };
      if (!isRecord(body) || typeof body.token !== "string" || typeof body.login !== "string" || !isStringArray(body.owners)) {
        throw new Error("registry sent an unexpected login response");
      }
      return { status: "done", token: body.token, login: body.login, owners: body.owners };
    },

    async whoami(token: string): Promise<Identity> {
      const { body } = await request("/auth/whoami", { headers: bearer(token) });
      if (!isRecord(body) || typeof body.login !== "string" || !isStringArray(body.owners)) {
        throw new Error("registry sent an unexpected whoami response");
      }
      return { login: body.login, owners: body.owners };
    },

    async revoke(token: string): Promise<void> {
      await request("/auth/token", { method: "DELETE", headers: bearer(token) });
    },

    async search(query: string): Promise<RegistryListing[]> {
      const { body } = await request(`/registries?q=${encodeURIComponent(query)}`);
      if (!isRecord(body) || !Array.isArray(body.registries)) throw new Error("registry sent an unexpected search response");
      return body.registries.filter(isListing);
    },

    async info(owner: string, name: string): Promise<RegistryInfo> {
      const { body } = await request(`/registries/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
      const rows: unknown = isRecord(body) ? body.versions : undefined;
      if (!isListing(body) || !Array.isArray(rows)) throw new Error("registry sent an unexpected registry response");
      const versions = rows.flatMap((row: unknown) => {
        if (!isRecord(row) || typeof row.version !== "string" || typeof row.createdAt !== "string") return [];
        const bump = typeof row.bump === "string" ? row.bump : null;
        const publishedBy = typeof row.publishedBy === "string" ? row.publishedBy : null;
        return [{ version: row.version, createdAt: row.createdAt, bump, publishedBy }];
      });
      const { owner: listedOwner, name: listedName, title, description, latest, updatedAt } = body;
      return { owner: listedOwner, name: listedName, title, description, latest, updatedAt, versions };
    },
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isListing(value: unknown): value is RegistryListing {
  return (
    isRecord(value) &&
    typeof value.owner === "string" &&
    typeof value.name === "string" &&
    typeof value.title === "string" &&
    (value.description === null || typeof value.description === "string") &&
    typeof value.latest === "string" &&
    typeof value.updatedAt === "string"
  );
}
