/**
 * The slice of Cloudflare's D1Database the store uses. D1Database fits it, and
 * tests can back it with bun:sqlite.
 */
export interface Database {
  prepare(query: string): Statement;
}

export type SqlValue = string | number | null;

export interface Statement {
  bind(...values: SqlValue[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface VersionRow {
  owner: string;
  name: string;
  version: string;
  hash: string;
  document: string;
}

export interface NewVersion extends VersionRow {
  /** JSON from diffDocuments against the version before it. */
  bump: string | null;
  changes: string | null;
  publishedBy: string;
}

export interface VersionInfo {
  version: string;
  hash: string;
  createdAt: string;
  bump: string | null;
  changes: string | null;
  publishedBy: string | null;
}

export interface RegistryRow {
  owner: string;
  name: string;
  title: string;
  description: string | null;
  latest: string;
  updatedAt: string;
}

export interface TokenRow {
  userId: string;
  login: string;
}

export interface Org {
  id: string;
  login: string;
}

export interface Membership extends Org {
  /** Checked at a login within MEMBERSHIP_MAX_AGE; older ones don't grant publishing. */
  isFresh: boolean;
}

export interface Store {
  /** Binds the login to `ownerId` on first push; returns whichever id it is bound to. */
  claimOwner(login: string, ownerId: string): Promise<string | null>;
  /** False when the version already exists. */
  insertVersion(row: NewVersion): Promise<boolean>;
  /** Moves the listing row to `latest` and its title, when `latest` is the newest version. */
  updateRegistry(row: Omit<RegistryRow, "updatedAt">): Promise<void>;
  findVersion(owner: string, name: string, version: string): Promise<VersionRow | null>;
  listVersions(owner: string, name: string): Promise<string[]>;
  listVersionInfo(owner: string, name: string): Promise<VersionInfo[]>;
  findRegistry(owner: string, name: string): Promise<RegistryRow | null>;
  /** Newest first; `query` matches owner/name, title and description. */
  searchRegistries(query: string, limit: number): Promise<RegistryRow[]>;
  createToken(hash: string, user: TokenRow): Promise<void>;
  /** Null for unknown tokens and ones older than TOKEN_MAX_AGE. */
  findToken(hash: string): Promise<TokenRow | null>;
  deleteToken(hash: string): Promise<void>;
  replaceMemberships(userId: string, orgs: Org[]): Promise<void>;
  listMemberships(userId: string): Promise<Membership[]>;
}

// SQLite datetime() modifiers. A token that leaks or outlives its owner's
// laptop ages out; a membership has to be re-checked by logging in again.
const TOKEN_MAX_AGE = "-90 days";
const MEMBERSHIP_MAX_AGE = "-7 days";

const REGISTRY_COLUMNS =
  "owner, name, title, description, latest, updated_at AS updatedAt FROM registries";

export function d1Store(db: Database): Store {
  return {
    async claimOwner(login, ownerId) {
      // INSERT OR IGNORE then read back: two concurrent first pushes can't both win.
      await db
        .prepare("INSERT OR IGNORE INTO owners (login, owner_id) VALUES (?, ?)")
        .bind(login, ownerId)
        .run();
      const row = await db
        .prepare("SELECT owner_id FROM owners WHERE login = ?")
        .bind(login)
        .first<{ owner_id: string }>();
      return row?.owner_id ?? null;
    },

    async insertVersion({ owner, name, version, hash, document, bump, changes, publishedBy }) {
      // Versions are immutable: never overwrite, let the caller compare hashes.
      const { meta } = await db
        .prepare(
          "INSERT OR IGNORE INTO versions (owner, name, version, hash, document, bump, changes, published_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(owner, name, version, hash, document, bump, changes, publishedBy)
        .run();
      return meta.changes > 0;
    },

    async updateRegistry({ owner, name, title, description, latest }) {
      await db
        .prepare(
          `INSERT INTO registries (owner, name, title, description, latest) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (owner, name) DO UPDATE SET title = excluded.title, description = excluded.description,
             latest = excluded.latest, updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(owner, name, title, description, latest)
        .run();
    },

    findVersion(owner, name, version) {
      return db
        .prepare(
          "SELECT owner, name, version, hash, document FROM versions WHERE owner = ? AND name = ? AND version = ?",
        )
        .bind(owner, name, version)
        .first<VersionRow>();
    },

    async listVersions(owner, name) {
      const { results } = await db
        .prepare("SELECT version FROM versions WHERE owner = ? AND name = ?")
        .bind(owner, name)
        .all<{ version: string }>();
      return results.map((row) => row.version);
    },

    async listVersionInfo(owner, name) {
      const { results } = await db
        .prepare(
          "SELECT version, hash, created_at AS createdAt, bump, changes, published_by AS publishedBy FROM versions WHERE owner = ? AND name = ?",
        )
        .bind(owner, name)
        .all<VersionInfo>();
      return results;
    },

    findRegistry(owner, name) {
      return db
        .prepare(`SELECT ${REGISTRY_COLUMNS} WHERE owner = ? AND name = ?`)
        .bind(owner, name)
        .first<RegistryRow>();
    },

    async searchRegistries(query, limit) {
      // LIKE wildcards in the query match themselves.
      const pattern = `%${query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
      const { results } = await db
        .prepare(
          `SELECT ${REGISTRY_COLUMNS}
           WHERE owner || '/' || name LIKE ?1 ESCAPE '\\' OR lower(title) LIKE ?1 ESCAPE '\\' OR lower(coalesce(description, '')) LIKE ?1 ESCAPE '\\'
           ORDER BY updated_at DESC, owner, name LIMIT ?2`,
        )
        .bind(pattern, limit)
        .all<RegistryRow>();
      return results;
    },

    async createToken(hash, { userId, login }) {
      await db
        .prepare("INSERT INTO tokens (hash, user_id, login) VALUES (?, ?, ?)")
        .bind(hash, userId, login)
        .run();
    },

    async findToken(hash) {
      const row = await db
        .prepare("SELECT user_id AS userId, login FROM tokens WHERE hash = ? AND created_at >= datetime('now', ?)")
        .bind(hash, TOKEN_MAX_AGE)
        .first<TokenRow>();
      if (row) {
        await db.prepare("UPDATE tokens SET last_used_at = CURRENT_TIMESTAMP WHERE hash = ?").bind(hash).run();
      }
      return row;
    },

    async deleteToken(hash) {
      await db.prepare("DELETE FROM tokens WHERE hash = ?").bind(hash).run();
    },

    async replaceMemberships(userId, orgs) {
      await db.prepare("DELETE FROM memberships WHERE user_id = ?").bind(userId).run();
      for (const org of orgs) {
        await db
          .prepare(
            "INSERT OR IGNORE INTO memberships (user_id, org_id, org_login, checked_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
          )
          .bind(userId, org.id, org.login.toLowerCase())
          .run();
      }
    },

    async listMemberships(userId) {
      const { results } = await db
        .prepare(
          "SELECT org_id AS id, org_login AS login, coalesce(checked_at >= datetime('now', ?), 0) AS isFresh FROM memberships WHERE user_id = ?",
        )
        .bind(MEMBERSHIP_MAX_AGE, userId)
        .all<{ id: string; login: string; isFresh: number }>();
      return results.map((row) => ({ ...row, isFresh: row.isFresh === 1 }));
    },
  };
}
