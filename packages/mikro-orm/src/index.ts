import {
  EntitySchema,
  LockMode,
  TextType,
  type EntityManager,
  type EntityProperty,
  type Platform,
} from "@mikro-orm/core";
import type { OutboxAdapter, OutboxRow } from "@typedhook/sdk";

export interface WebhookOutboxSchemaOptions {
  /** Table name (unquoted identifier). Default "webhook_outbox". */
  tableName?: string;
}

export interface MikroOrmAdapterOptions {
  /** The outbox entity registered in your `entities`. Default `WebhookOutbox`. */
  entity?: EntitySchema<OutboxRow>;
  /**
   * How long claimed rows stay invisible to other workers before a crashed
   * worker's rows become due again. Must exceed the worker's delivery
   * timeoutMs. Default 60_000.
   */
  claimTimeoutMs?: number;
}

// MikroORM quotes the table name, but reads a dot as a schema separator;
// restrict it to a plain identifier so the name means one thing everywhere.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// MySQL's TEXT stops at 64 KB and webhook bodies can be bigger; Postgres and
// SQLite text is already unbounded. MikroORM has no long-text type, and
// supportsUnsigned() is the platform flag only the MySQL family (MySQL,
// MariaDB) sets.
class LongTextType extends TextType {
  override getColumnType(prop: EntityProperty, platform: Platform) {
    return platform.supportsUnsigned() ? "longtext" : super.getColumnType(prop, platform);
  }
}

/**
 * Builds the outbox entity under a custom table name. Add the result to your
 * `entities` and pass it to the adapter as `{ entity }`.
 */
export function webhookOutboxSchema(options: WebhookOutboxSchemaOptions = {}) {
  const tableName = options.tableName ?? "webhook_outbox";
  if (!IDENTIFIER.test(tableName)) {
    throw new Error(`invalid table name "${tableName}": must be a plain SQL identifier`);
  }

  return new EntitySchema<OutboxRow>({
    name: "WebhookOutbox",
    tableName,
    properties: {
      id: { type: "string", primary: true },
      eventId: { type: "string" },
      eventType: { type: "string" },
      subject: { type: "string", nullable: true },
      body: { type: LongTextType },
      url: { type: "text" },
      secret: { type: "text", nullable: true },
      attempts: { type: "integer" },
      // Millisecond precision: MySQL's default DATETIME rounds to whole
      // seconds, which would make freshly scheduled rows due late.
      nextAttemptAt: { type: "datetime", length: 3 },
      status: { type: "string" },
      lastError: { type: "text", nullable: true },
      createdAt: { type: "datetime", length: 3 },
    },
    indexes: [{ properties: ["status", "nextAttemptAt"] }],
  });
}

/** The outbox entity, table "webhook_outbox". Add it to your `entities`. */
export const WebhookOutbox = webhookOutboxSchema();

/**
 * Postgres and MySQL 8+: claim selects due rows with
 * `FOR UPDATE SKIP LOCKED` inside its own transaction and pushes their
 * nextAttemptAt claimTimeoutMs into the future before committing, so
 * concurrent workers never grab the same row. Rows stay `pending` while
 * claimed; a crashed worker's rows are redelivered after the timeout
 * (at-least-once). On SQLite (MikroORM 7) the lock is dropped and SQLite's
 * single writer does the same job.
 *
 * `with(em)` takes the EntityManager from `em.transactional(async (em) => ...)`;
 * the insert runs right away on that transaction, it doesn't wait for a flush.
 */
export function mikroOrmOutboxAdapter<Tx extends EntityManager = EntityManager>(
  em: EntityManager,
  options: MikroOrmAdapterOptions = {},
): OutboxAdapter<Tx> {
  const entity = options.entity ?? WebhookOutbox;
  const claimTimeoutMs = options.claimTimeoutMs ?? 60_000;

  // Fork per call: the global EntityManager refuses context-specific work,
  // and a fork keeps the adapter's identity map out of the caller's.
  async function update(rowId: string, data: Partial<OutboxRow>) {
    await em.fork().nativeUpdate(entity, { id: rowId }, data);
  }

  return {
    async insert(rows, tx) {
      await (tx ?? em.fork()).insertMany(entity, rows);
    },
    async claim(limit, now) {
      const claimedUntil = new Date(now.getTime() + claimTimeoutMs);
      return em.fork().transactional(async (claimEm) => {
        const due = await claimEm.find(
          entity,
          { status: "pending", nextAttemptAt: { $lte: now } },
          {
            orderBy: { nextAttemptAt: "asc" },
            limit,
            lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
            // Unmanaged rows: the commit's flush must not write the loaded
            // (pre-claim) values back over the nativeUpdate below.
            disableIdentityMap: true,
          },
        );
        if (due.length === 0) return [];

        await claimEm.nativeUpdate(
          entity,
          { id: { $in: due.map((row) => row.id) } },
          { nextAttemptAt: claimedUntil },
        );
        // nextAttemptAt on the returned rows is the bumped claim horizon, not
        // the original schedule — the worker never reads it, hooks might.
        return due.map(
          (row): OutboxRow => ({
            id: row.id,
            eventId: row.eventId,
            eventType: row.eventType,
            subject: row.subject,
            body: row.body,
            url: row.url,
            secret: row.secret,
            attempts: row.attempts,
            nextAttemptAt: claimedUntil,
            status: row.status,
            lastError: row.lastError,
            createdAt: row.createdAt,
          }),
        );
      });
    },
    async complete(rowId) {
      await update(rowId, { status: "delivered" });
    },
    async retry(rowId, attempts, nextAttemptAt, lastError) {
      await update(rowId, { attempts, nextAttemptAt, lastError });
    },
    async dead(rowId, attempts, lastError) {
      await update(rowId, { status: "dead", attempts, lastError });
    },
  };
}
