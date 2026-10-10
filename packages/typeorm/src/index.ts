import type { OutboxAdapter, OutboxRow } from "@thallesp/webhooks";
import {
  EntitySchema,
  In,
  type DataSource,
  type EntityManager,
  type EntitySchemaColumnOptions,
} from "typeorm";

/** DataSource `type`s the adapter supports: both have FOR UPDATE SKIP LOCKED. */
export type OutboxDatabaseType = "postgres" | "mysql";

export interface WebhookOutboxSchemaOptions {
  /** Your DataSource's `type`. Picks the timestamp and long-text column types. */
  type: OutboxDatabaseType;
  /** Table (and entity) name, a plain SQL identifier. Default "webhook_outbox". */
  table?: string;
}

export interface TypeormAdapterOptions {
  /** Table (and entity) name — same as the one given to webhookOutboxSchema. Default "webhook_outbox". */
  table?: string;
  /**
   * How long claimed rows stay invisible to other workers before a crashed
   * worker's rows become due again. Must exceed the worker's delivery
   * timeoutMs. Default 60_000.
   */
  claimTimeoutMs?: number;
}

// timestamptz keeps Postgres timezone-safe; MySQL needs datetime(3) to keep
// milliseconds and longtext so bodies over TEXT's 64 KB still fit.
const columnTypes: Record<
  OutboxDatabaseType,
  { timestamp: EntitySchemaColumnOptions; longText: EntitySchemaColumnOptions }
> = {
  postgres: { timestamp: { type: "timestamptz" }, longText: { type: "text" } },
  mysql: { timestamp: { type: "datetime", precision: 3 }, longText: { type: "longtext" } },
};

// TypeORM quotes the name itself, but it also names the index and appears in
// the SQL users copy from the README, so keep it a plain identifier.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(table: string) {
  if (IDENTIFIER.test(table)) return;
  throw new Error(`invalid table name "${table}": must be a plain SQL identifier`);
}

function isSupported(type: string): type is OutboxDatabaseType {
  return type === "postgres" || type === "mysql";
}

function assertSupported(type: string) {
  if (isSupported(type)) return;
  throw new Error(
    `typeorm database type "${type}" is not supported — claim needs FOR UPDATE SKIP LOCKED (postgres, mysql 8+)`,
  );
}

/**
 * Outbox entity to add to your DataSource's `entities` — no decorators needed.
 * `typeorm migration:generate` picks it up; the README has the SQL to copy.
 */
export function webhookOutboxSchema(options: WebhookOutboxSchemaOptions): EntitySchema<OutboxRow> {
  const table = options.table ?? "webhook_outbox";
  assertIdentifier(table);
  assertSupported(options.type);

  const { timestamp, longText } = columnTypes[options.type];
  const shortText: EntitySchemaColumnOptions = { type: "varchar", length: 255 };
  return new EntitySchema<OutboxRow>({
    name: table,
    tableName: table,
    columns: {
      id: { ...shortText, primary: true, primaryKeyConstraintName: `${table}_pkey` },
      eventId: shortText,
      eventType: shortText,
      subject: { ...shortText, nullable: true },
      body: longText,
      url: { type: "text" },
      secret: { type: "text", nullable: true },
      attempts: { type: "int" },
      nextAttemptAt: timestamp,
      status: shortText,
      lastError: { type: "text", nullable: true },
      createdAt: timestamp,
    },
    indices: [{ name: `${table}_status_nextAttemptAt_idx`, columns: ["status", "nextAttemptAt"] }],
  });
}

/**
 * Postgres and MySQL 8+: claim selects due rows `FOR UPDATE SKIP LOCKED` and
 * pushes their nextAttemptAt claimTimeoutMs into the future in the same
 * transaction, so concurrent workers never grab the same row. Rows stay
 * `pending` while claimed; a crashed worker's rows are redelivered after the
 * timeout (at-least-once).
 *
 * Register `webhookOutboxSchema({ type, table })` in the DataSource's entities.
 * `with(tx)` takes the EntityManager from `dataSource.transaction(...)`.
 */
export function typeormOutboxAdapter<Tx extends EntityManager = EntityManager>(
  dataSource: DataSource,
  options: TypeormAdapterOptions = {},
): OutboxAdapter<Tx> {
  const table = options.table ?? "webhook_outbox";
  const claimTimeoutMs = options.claimTimeoutMs ?? 60_000;
  assertIdentifier(table);
  assertSupported(dataSource.options.type);

  return {
    async insert(rows, tx) {
      await (tx ?? dataSource.manager).insert<OutboxRow>(table, rows);
    },
    async claim(limit, now) {
      const claimedUntil = new Date(now.getTime() + claimTimeoutMs);
      // READ COMMITTED: under MySQL's default REPEATABLE READ the locking
      // select also gap-locks the scanned index range, blocking inserts from
      // send() until the claim commits.
      return dataSource.transaction("READ COMMITTED", async (manager) => {
        const due = await manager
          .createQueryBuilder<OutboxRow>(table, "outbox")
          .where("outbox.status = :status", { status: "pending" })
          .andWhere("outbox.nextAttemptAt <= :now", { now })
          .orderBy("outbox.nextAttemptAt")
          .limit(limit)
          .setLock("pessimistic_write")
          .setOnLocked("skip_locked")
          .getMany();
        if (due.length === 0) return [];

        await manager.update<OutboxRow>(
          table,
          { id: In(due.map((row) => row.id)) },
          { nextAttemptAt: claimedUntil },
        );
        // nextAttemptAt on the returned rows is the bumped claim horizon, not
        // the original schedule — the worker never reads it, hooks might.
        return due.map((row) => ({ ...row, nextAttemptAt: claimedUntil }));
      });
    },
    async complete(rowId) {
      await dataSource.manager.update<OutboxRow>(table, { id: rowId }, { status: "delivered" });
    },
    async retry(rowId, attempts, nextAttemptAt, lastError) {
      await dataSource.manager.update<OutboxRow>(
        table,
        { id: rowId },
        { attempts, nextAttemptAt, lastError },
      );
    },
    async dead(rowId, attempts, lastError) {
      await dataSource.manager.update<OutboxRow>(
        table,
        { id: rowId },
        { status: "dead", attempts, lastError },
      );
    },
  };
}
