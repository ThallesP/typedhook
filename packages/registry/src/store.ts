/**
 * The slice of Cloudflare's D1Database the store uses. D1Database fits it, and
 * tests can back it with bun:sqlite.
 */
export interface Database {
  prepare(query: string): Statement;
}

export interface Statement {
  bind(...values: string[]): Statement;
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

export interface Store {
  /** Binds the login to `ownerId` on first push; returns whichever id it is bound to. */
  claimOwner(login: string, ownerId: string): Promise<string | null>;
  /** False when the version already exists. */
  insertVersion(row: VersionRow): Promise<boolean>;
  findVersion(owner: string, name: string, version: string): Promise<VersionRow | null>;
  listVersions(owner: string, name: string): Promise<string[]>;
}

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

    async insertVersion({ owner, name, version, hash, document }) {
      // Versions are immutable: never overwrite, let the caller compare hashes.
      const { meta } = await db
        .prepare(
          "INSERT OR IGNORE INTO versions (owner, name, version, hash, document) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(owner, name, version, hash, document)
        .run();
      return meta.changes > 0;
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
  };
}
