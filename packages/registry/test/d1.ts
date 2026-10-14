import { Database as Sqlite } from "bun:sqlite";
import type { Database, Statement } from "../src/store";

const migration = await Bun.file(new URL("../migrations/0001_init.sql", import.meta.url)).text();

/** An in-memory D1 stand-in with the migration applied. */
export function memoryD1(): Database {
  const sqlite = new Sqlite(":memory:", { strict: true });
  sqlite.run(migration);

  function statement(query: string, values: string[]): Statement {
    return {
      bind: (...next) => statement(query, next),
      first: async <T>() => sqlite.query<T, string[]>(query).get(...values),
      all: async <T>() => ({ results: sqlite.query<T, string[]>(query).all(...values) }),
      run: async () => ({ meta: { changes: sqlite.query(query).run(...values).changes } }),
    };
  }

  return { prepare: (query) => statement(query, []) };
}
