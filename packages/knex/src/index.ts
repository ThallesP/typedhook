import type { OutboxAdapter, OutboxRow } from "@typedhook/sdk";
import type { Knex } from "knex";

export interface KnexAdapterOptions {
  /** Outbox table name (unquoted identifier). Default "webhook_outbox". */
  table?: string;
  /**
   * How long claimed rows stay invisible to other workers before a crashed
   * worker's rows become due again. Must exceed the worker's delivery
   * timeoutMs. Default 60_000.
   */
  claimTimeoutMs?: number;
}

// The table name is interpolated into SQL (identifiers can't be bound as
// parameters), so restrict it to a plain identifier even though it comes from
// config, not user input.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// sqlite3 hands dates back as epoch milliseconds, some MySQL/pg setups as
// strings.
type StoredDate = Date | string | number;

type OutboxRecord = Omit<OutboxRow, "nextAttemptAt" | "createdAt"> & {
  nextAttemptAt: StoredDate;
  createdAt: StoredDate;
};

function toDate(value: StoredDate): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Postgres, MySQL 8+ and SQLite. claim selects due rows with
 * `FOR UPDATE SKIP LOCKED` and pushes their nextAttemptAt claimTimeoutMs into
 * the future in the same transaction, so concurrent workers never grab the
 * same row. Rows stay `pending` while claimed; a crashed worker's rows are
 * redelivered after the timeout (at-least-once).
 *
 * `with(tx)` takes a `Knex.Transaction` (any Knex instance works).
 */
export function knexOutboxAdapter<Tx extends Knex = Knex.Transaction>(
  db: Knex,
  options: KnexAdapterOptions = {},
): OutboxAdapter<Tx> {
  const table = options.table ?? "webhook_outbox";
  const claimTimeoutMs = options.claimTimeoutMs ?? 60_000;
  if (!IDENTIFIER.test(table)) {
    throw new Error(`invalid table name "${table}": must be a plain SQL identifier`);
  }
  // better-sqlite3's client reports the same dialect.
  const isSqlite = db.client.dialect === "sqlite3";

  return {
    async insert(rows, tx) {
      await (tx ?? db)(table).insert(rows);
    },
    async claim(limit, now) {
      const claimedUntil = new Date(now.getTime() + claimTimeoutMs);
      // Select-then-update instead of UPDATE ... RETURNING: MySQL has no
      // RETURNING and rejects LIMIT in an IN subquery on the updated table.
      const records = await db.transaction(async (trx) => {
        const dueQuery = trx<OutboxRecord>(table)
          .where("status", "pending")
          .andWhere("nextAttemptAt", "<=", now)
          .orderBy("nextAttemptAt")
          .limit(limit);
        // SQLite has no row locks (knex throws on skipLocked); it allows one
        // writer at a time, so the transaction alone keeps claims apart.
        const due = await (isSqlite ? dueQuery : dueQuery.forUpdate().skipLocked());
        if (due.length === 0) return [];
        await trx<OutboxRecord>(table)
          .whereIn("id", due.map((record) => record.id))
          .update({ nextAttemptAt: claimedUntil });
        return due;
      });
      // nextAttemptAt on the returned rows is the bumped claim horizon, not
      // the original schedule — the worker never reads it, hooks might.
      return records.map(
        (record): OutboxRow => ({
          id: record.id,
          eventId: record.eventId,
          eventType: record.eventType,
          subject: record.subject,
          body: record.body,
          url: record.url,
          secret: record.secret,
          attempts: Number(record.attempts),
          nextAttemptAt: claimedUntil,
          status: record.status,
          lastError: record.lastError,
          createdAt: toDate(record.createdAt),
        }),
      );
    },
    async complete(rowId) {
      await db(table).where("id", rowId).update({ status: "delivered" });
    },
    async retry(rowId, attempts, nextAttemptAt, lastError) {
      await db(table).where("id", rowId).update({ attempts, nextAttemptAt, lastError });
    },
    async dead(rowId, attempts, lastError) {
      await db(table).where("id", rowId).update({ status: "dead", attempts, lastError });
    },
  };
}
