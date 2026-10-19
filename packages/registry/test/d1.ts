import { Database as Sqlite } from "bun:sqlite";
import type { Database, SqlValue, Statement } from "../src/store";

const migrations = await Promise.all(
  ["0001_init.sql", "0002_accounts_and_listing.sql", "0003_membership_checks.sql"].map((file) =>
    Bun.file(new URL(`../migrations/${file}`, import.meta.url)).text(),
  ),
);

/** An in-memory D1 stand-in with the migrations applied. */
export function memoryD1(): Database {
  const sqlite = new Sqlite(":memory:", { strict: true });
  for (const migration of migrations) sqlite.run(migration);

  function statement(query: string, values: SqlValue[]): Statement {
    return {
      bind: (...next) => statement(query, next),
      first: async <T>() => sqlite.query<T, SqlValue[]>(query).get(...values),
      all: async <T>() => ({ results: sqlite.query<T, SqlValue[]>(query).all(...values) }),
      run: async () => ({ meta: { changes: sqlite.query(query).run(...values).changes } }),
    };
  }

  return { prepare: (query) => statement(query, []) };
}
