import type { OutboxAdapter, OutboxRow } from "@thallesp/webhooks";
import type { Kysely, Transaction } from "kysely";

/**
 * Columns of the outbox table. Dates are `Date` on Postgres and MySQL; on
 * SQLite the adapter stores ISO-8601 text, so use `WebhookOutboxTable<string>`.
 */
export interface WebhookOutboxTable<DateColumn = Date> {
  id: string;
  eventId: string;
  eventType: string;
  subject: string | null;
  body: string;
  url: string;
  secret: string | null;
  attempts: number;
  nextAttemptAt: DateColumn;
  status: string;
  lastError: string | null;
  createdAt: DateColumn;
}

/**
 * Database fragment to merge into your Kysely `DB` type:
 * `interface DB extends WebhookOutboxDatabase { users: UserTable }`.
 * Pass the table name if you changed it with `{ table }`.
 */
export type WebhookOutboxDatabase<
  Table extends string = "webhook_outbox",
  DateColumn = Date,
> = Record<Table, WebhookOutboxTable<DateColumn>>;

export interface KyselyAdapterOptions {
  /**
   * Your Kysely dialect. Picks the claim strategy: Postgres and MySQL lock with
   * `FOR UPDATE SKIP LOCKED`, SQLite relies on its single writer.
   */
  dialect: "postgres" | "mysql" | "sqlite";
  /** Outbox table name (unquoted identifier). Default "webhook_outbox". */
  table?: string;
  /**
   * How long claimed rows stay invisible to other workers before a crashed
   * worker's rows become due again. Must exceed the worker's delivery
   * timeoutMs. Default 60_000.
   */
  claimTimeoutMs?: number;
}

type OutboxDatabase = Record<string, WebhookOutboxTable<Date | string>>;

// Restrict the table name to a plain identifier, like the Prisma adapter, even
// though it comes from config, not user input.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The table is named at runtime, so the caller's DB type can't type these
// queries; view the executor through the outbox table's shape instead.
function outboxDb(executor: Kysely<any>): Kysely<OutboxDatabase> {
  return executor;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toOutboxRow(row: WebhookOutboxTable<Date | string>): OutboxRow {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    subject: row.subject,
    body: row.body,
    url: row.url,
    secret: row.secret,
    attempts: Number(row.attempts),
    nextAttemptAt: toDate(row.nextAttemptAt),
    status: row.status as OutboxRow["status"],
    lastError: row.lastError,
    createdAt: toDate(row.createdAt),
  };
}

/**
 * Claiming is safe with concurrent workers. Postgres: one
 * `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *`.
 * MySQL (no RETURNING): `SELECT … FOR UPDATE SKIP LOCKED` then `UPDATE` in one
 * transaction. SQLite: one `UPDATE … RETURNING *` (writes are serialized).
 * Rows stay `pending` while claimed; their nextAttemptAt is pushed
 * claimTimeoutMs into the future, so a crashed worker's rows are redelivered
 * after the timeout (at-least-once).
 *
 * `with(trx)` is typed as `Transaction<DB>`, inferred from `db`.
 */
export function kyselyOutboxAdapter<DB>(
  db: Kysely<DB>,
  options: KyselyAdapterOptions,
): OutboxAdapter<Transaction<DB>> {
  const { dialect } = options;
  const table = options.table ?? "webhook_outbox";
  const claimTimeoutMs = options.claimTimeoutMs ?? 60_000;
  if (!IDENTIFIER.test(table)) {
    throw new Error(`invalid table name "${table}": must be a plain SQL identifier`);
  }
  const base = outboxDb(db);

  // SQLite has no date type and its drivers don't bind Date; ISO-8601 text
  // compares in time order.
  function toColumn(date: Date): Date | string {
    return dialect === "sqlite" ? date.toISOString() : date;
  }

  async function claimWithReturning(limit: number, now: Date, claimedUntil: Date) {
    return base
      .updateTable(table)
      .set({ nextAttemptAt: toColumn(claimedUntil) })
      .where("id", "in", (eb) =>
        eb
          .selectFrom(table)
          .select("id")
          .where("status", "=", "pending")
          .where("nextAttemptAt", "<=", toColumn(now))
          .orderBy("nextAttemptAt")
          .limit(limit)
          .$if(dialect === "postgres", (query) => query.forUpdate().skipLocked()),
      )
      .returningAll()
      .execute();
  }

  // MySQL has no RETURNING and can't UPDATE a table it subqueries, so lock the
  // rows first and mark them in the same transaction.
  async function claimWithoutReturning(limit: number, now: Date, claimedUntil: Date) {
    return base.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom(table)
        .selectAll()
        .where("status", "=", "pending")
        .where("nextAttemptAt", "<=", now)
        .orderBy("nextAttemptAt")
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) return [];

      await trx
        .updateTable(table)
        .set({ nextAttemptAt: claimedUntil })
        .where(
          "id",
          "in",
          rows.map((row) => row.id),
        )
        .execute();
      return rows.map((row) => ({ ...row, nextAttemptAt: claimedUntil }));
    });
  }

  return {
    async insert(rows, tx) {
      await outboxDb(tx ?? db)
        .insertInto(table)
        .values(
          rows.map((row) => ({
            ...row,
            nextAttemptAt: toColumn(row.nextAttemptAt),
            createdAt: toColumn(row.createdAt),
          })),
        )
        .execute();
    },
    async claim(limit, now) {
      const claimedUntil = new Date(now.getTime() + claimTimeoutMs);
      const rows =
        dialect === "mysql"
          ? await claimWithoutReturning(limit, now, claimedUntil)
          : await claimWithReturning(limit, now, claimedUntil);
      // nextAttemptAt on the returned rows is the bumped claim horizon, not
      // the original schedule — the worker never reads it, hooks might.
      return rows.map(toOutboxRow);
    },
    async complete(rowId) {
      await base.updateTable(table).set({ status: "delivered" }).where("id", "=", rowId).execute();
    },
    async retry(rowId, attempts, nextAttemptAt, lastError) {
      await base
        .updateTable(table)
        .set({ attempts, nextAttemptAt: toColumn(nextAttemptAt), lastError })
        .where("id", "=", rowId)
        .execute();
    },
    async dead(rowId, attempts, lastError) {
      await base
        .updateTable(table)
        .set({ status: "dead", attempts, lastError })
        .where("id", "=", rowId)
        .execute();
    },
  };
}
