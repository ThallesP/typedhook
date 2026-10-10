import type { OutboxAdapter, OutboxRow } from "@typedhook/sdk";
import { and, asc, eq, inArray, is, lte, type TablesRelationalConfig } from "drizzle-orm";
import {
  MySqlDatabase,
  MySqlTable,
  type MySqlColumn,
  type MySqlQueryResultHKT,
  type MySqlTransaction,
  type PreparedQueryHKTBase,
} from "drizzle-orm/mysql-core";
import {
  PgDatabase,
  PgTable,
  type PgColumn,
  type PgQueryResultHKT,
  type PgTransaction,
} from "drizzle-orm/pg-core";
import { BaseSQLiteDatabase, SQLiteTable, type SQLiteColumn } from "drizzle-orm/sqlite-core";

/** Every OutboxRow field must be a column under the same property name. */
type OutboxColumns<TColumn> = { [K in keyof OutboxRow]: TColumn };

export type PgOutboxTable = PgTable & OutboxColumns<PgColumn>;
export type MySqlOutboxTable = MySqlTable & OutboxColumns<MySqlColumn>;
export type SQLiteOutboxTable = SQLiteTable & OutboxColumns<SQLiteColumn>;

export interface DrizzleAdapterOptions<TTable> {
  /** Your outbox table, from the README definition for your dialect. */
  table: TTable;
  /**
   * How long claimed rows stay invisible to other workers before a crashed
   * worker's rows become due again. Must exceed the worker's delivery
   * timeoutMs. Default 60_000.
   */
  claimTimeoutMs?: number;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

function toRow(row: Record<string, unknown>): OutboxRow {
  return {
    id: String(row.id),
    eventId: String(row.eventId),
    eventType: String(row.eventType),
    subject: row.subject === null ? null : String(row.subject),
    body: String(row.body),
    url: String(row.url),
    secret: row.secret === null ? null : String(row.secret),
    attempts: Number(row.attempts),
    nextAttemptAt: toDate(row.nextAttemptAt),
    status: row.status as OutboxRow["status"],
    lastError: row.lastError === null ? null : String(row.lastError),
    createdAt: toDate(row.createdAt),
  };
}

type OutboxTable = PgOutboxTable | MySqlOutboxTable | SQLiteOutboxTable;

// is(table, SQLiteTable) alone doesn't narrow the OutboxTable union.
function isSQLiteOutboxTable(table: OutboxTable): table is SQLiteOutboxTable {
  return is(table, SQLiteTable);
}

function isDue(table: OutboxTable, now: Date) {
  return and(eq(table.status, "pending"), lte(table.nextAttemptAt, now));
}

function pgAdapter<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TQueryResult, TFullSchema, TSchema>,
  table: PgOutboxTable,
  claimTimeoutMs: number,
): OutboxAdapter<PgTransaction<TQueryResult, TFullSchema, TSchema>> {
  return {
    async insert(rows, tx) {
      await (tx ?? db).insert(table).values(rows);
    },
    async claim(limit, now) {
      const due = db
        .select({ id: table.id })
        .from(table)
        .where(isDue(table, now))
        .orderBy(asc(table.nextAttemptAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      const claimed = await db
        .update(table)
        .set({ nextAttemptAt: new Date(now.getTime() + claimTimeoutMs) })
        .where(inArray(table.id, due))
        .returning();
      return claimed.map(toRow);
    },
    async complete(rowId) {
      await db.update(table).set({ status: "delivered" }).where(eq(table.id, rowId));
    },
    async retry(rowId, attempts, nextAttemptAt, lastError) {
      await db
        .update(table)
        .set({ attempts, nextAttemptAt, lastError })
        .where(eq(table.id, rowId));
    },
    async dead(rowId, attempts, lastError) {
      await db
        .update(table)
        .set({ status: "dead", attempts, lastError })
        .where(eq(table.id, rowId));
    },
  };
}

function mysqlAdapter<
  TQueryResult extends MySqlQueryResultHKT,
  TPreparedQueryHKT extends PreparedQueryHKTBase,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: MySqlDatabase<TQueryResult, TPreparedQueryHKT, TFullSchema, TSchema>,
  table: MySqlOutboxTable,
  claimTimeoutMs: number,
): OutboxAdapter<MySqlTransaction<TQueryResult, TPreparedQueryHKT, TFullSchema, TSchema>> {
  return {
    async insert(rows, tx) {
      await (tx ?? db).insert(table).values(rows);
    },
    async claim(limit, now) {
      // No UPDATE ... RETURNING in MySQL: lock the due ids, bump them, then
      // read the rows back, all in one transaction. Selecting only ids lets
      // InnoDB walk the (status, nextAttemptAt) index and lock just `limit`
      // rows; SELECT * filesorts and locks every due row, serializing workers.
      // READ COMMITTED skips gap locks that would block producers' inserts.
      return db.transaction(
        async (tx) => {
          const due = await tx
            .select({ id: table.id })
            .from(table)
            .where(isDue(table, now))
            .orderBy(asc(table.nextAttemptAt))
            .limit(limit)
            .for("update", { skipLocked: true });
          if (due.length === 0) return [];
          const ids = due.map((row) => row.id);
          await tx
            .update(table)
            .set({ nextAttemptAt: new Date(now.getTime() + claimTimeoutMs) })
            .where(inArray(table.id, ids));
          const claimed = await tx.select().from(table).where(inArray(table.id, ids));
          return claimed.map(toRow);
        },
        { isolationLevel: "read committed" },
      );
    },
    async complete(rowId) {
      await db.update(table).set({ status: "delivered" }).where(eq(table.id, rowId));
    },
    async retry(rowId, attempts, nextAttemptAt, lastError) {
      await db
        .update(table)
        .set({ attempts, nextAttemptAt, lastError })
        .where(eq(table.id, rowId));
    },
    async dead(rowId, attempts, lastError) {
      await db
        .update(table)
        .set({ status: "dead", attempts, lastError })
        .where(eq(table.id, rowId));
    },
  };
}

function sqliteAdapter<
  TResultKind extends "sync" | "async",
  TRunResult,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: BaseSQLiteDatabase<TResultKind, TRunResult, TFullSchema, TSchema>,
  table: SQLiteOutboxTable,
  claimTimeoutMs: number,
): OutboxAdapter<BaseSQLiteDatabase<TResultKind, TRunResult, TFullSchema, TSchema>> {
  return {
    async insert(rows, tx) {
      await (tx ?? db).insert(table).values(rows);
    },
    async claim(limit, now) {
      // SQLite runs one writer at a time, so a single UPDATE ... RETURNING
      // selects and bumps the due rows atomically.
      const due = db
        .select({ id: table.id })
        .from(table)
        .where(isDue(table, now))
        // Without $dynamic the chain's type collapses to a union while the
        // database's result kind (sync/async) is still generic.
        .$dynamic()
        .orderBy(asc(table.nextAttemptAt))
        .limit(limit);
      const claimed = await db
        .update(table)
        .set({ nextAttemptAt: new Date(now.getTime() + claimTimeoutMs) })
        .where(inArray(table.id, due))
        .returning();
      return claimed.map(toRow);
    },
    async complete(rowId) {
      await db.update(table).set({ status: "delivered" }).where(eq(table.id, rowId));
    },
    async retry(rowId, attempts, nextAttemptAt, lastError) {
      await db
        .update(table)
        .set({ attempts, nextAttemptAt, lastError })
        .where(eq(table.id, rowId));
    },
    async dead(rowId, attempts, lastError) {
      await db
        .update(table)
        .set({ status: "dead", attempts, lastError })
        .where(eq(table.id, rowId));
    },
  };
}

/**
 * Postgres and MySQL claim with `FOR UPDATE SKIP LOCKED` (MySQL 8+), SQLite
 * with a single UPDATE ... RETURNING, so concurrent workers never grab the
 * same row. Rows stay `pending` while claimed; their nextAttemptAt is pushed
 * claimTimeoutMs into the future, so a crashed worker's rows are redelivered
 * after the timeout (at-least-once).
 *
 * The transaction type is inferred from `db`, so `with(tx)` only accepts a
 * transaction from that database. SQLite also accepts the db itself: sync
 * drivers (bun:sqlite, better-sqlite3) can't await inside db.transaction, so
 * they enqueue between a manual BEGIN and COMMIT instead.
 */
export function drizzleOutboxAdapter<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TQueryResult, TFullSchema, TSchema>,
  options: DrizzleAdapterOptions<PgOutboxTable>,
): OutboxAdapter<PgTransaction<TQueryResult, TFullSchema, TSchema>>;
export function drizzleOutboxAdapter<
  TQueryResult extends MySqlQueryResultHKT,
  TPreparedQueryHKT extends PreparedQueryHKTBase,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: MySqlDatabase<TQueryResult, TPreparedQueryHKT, TFullSchema, TSchema>,
  options: DrizzleAdapterOptions<MySqlOutboxTable>,
): OutboxAdapter<MySqlTransaction<TQueryResult, TPreparedQueryHKT, TFullSchema, TSchema>>;
export function drizzleOutboxAdapter<
  TResultKind extends "sync" | "async",
  TRunResult,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: BaseSQLiteDatabase<TResultKind, TRunResult, TFullSchema, TSchema>,
  options: DrizzleAdapterOptions<SQLiteOutboxTable>,
): OutboxAdapter<BaseSQLiteDatabase<TResultKind, TRunResult, TFullSchema, TSchema>>;
export function drizzleOutboxAdapter(
  db: unknown,
  options: DrizzleAdapterOptions<OutboxTable>,
): OutboxAdapter<never> {
  const { table } = options;
  const claimTimeoutMs = options.claimTimeoutMs ?? 60_000;
  if (is(db, PgDatabase) && is(table, PgTable)) return pgAdapter(db, table, claimTimeoutMs);
  if (is(db, MySqlDatabase) && is(table, MySqlTable)) {
    return mysqlAdapter(db, table, claimTimeoutMs);
  }
  if (is(db, BaseSQLiteDatabase) && isSQLiteOutboxTable(table)) {
    return sqliteAdapter(db, table, claimTimeoutMs);
  }
  throw new Error(
    "drizzleOutboxAdapter needs a Postgres, MySQL or SQLite drizzle database and a table from the same dialect (pgTable, mysqlTable or sqliteTable)",
  );
}
