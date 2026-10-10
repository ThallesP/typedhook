import type { OutboxAdapter, OutboxRow } from "@typedhook/sdk";

/**
 * Structural slice of PrismaClient the adapter needs — keeps this package free
 * of a @prisma/client dependency. Your generated client satisfies it as-is.
 */
export interface PrismaLikeClient {
  $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
}

interface OutboxDelegate {
  createMany: (args: { data: OutboxRow[] }) => Promise<unknown>;
  updateMany: (args: {
    where: { id: string };
    data: Partial<Pick<OutboxRow, "status" | "attempts" | "nextAttemptAt" | "lastError">>;
  }) => Promise<unknown>;
}

export interface PrismaAdapterOptions {
  /** Client property holding the outbox model delegate. Default "webhookOutbox". */
  model?: string;
  /** Postgres table name for the raw claim query (unquoted identifier). Default "WebhookOutbox". */
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

function delegateOf(source: unknown, model: string): OutboxDelegate {
  const delegate = (source as Record<string, unknown>)[model];
  if (!delegate) {
    throw new Error(
      `prisma client has no model delegate "${model}" — pass { model } matching your schema, e.g. prismaOutboxAdapter(prisma, { model: "webhookOutbox" })`,
    );
  }
  return delegate as OutboxDelegate;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

/**
 * Postgres-only: claim uses `FOR UPDATE SKIP LOCKED` via $queryRawUnsafe, so
 * concurrent workers never grab the same row. Rows stay `pending` while
 * claimed; their nextAttemptAt is pushed claimTimeoutMs into the future, so a
 * crashed worker's rows are redelivered after the timeout (at-least-once).
 *
 * Expects the model's columns to use Prisma's default naming (no @map) — see
 * the README for the schema to paste.
 *
 * Pass your transaction type to keep `with(tx)` typesafe:
 * `prismaOutboxAdapter<Prisma.TransactionClient>(prisma)`.
 */
export function prismaOutboxAdapter<Tx = PrismaLikeClient>(
  client: PrismaLikeClient,
  options: PrismaAdapterOptions = {},
): OutboxAdapter<Tx> {
  const model = options.model ?? "webhookOutbox";
  const table = options.table ?? "WebhookOutbox";
  const claimTimeoutMs = options.claimTimeoutMs ?? 60_000;
  if (!IDENTIFIER.test(table)) {
    throw new Error(`invalid table name "${table}": must be a plain SQL identifier`);
  }

  const claimSql = `
    UPDATE "${table}" SET "nextAttemptAt" = $1
    WHERE "id" IN (
      SELECT "id" FROM "${table}"
      WHERE "status" = 'pending' AND "nextAttemptAt" <= $2
      ORDER BY "nextAttemptAt"
      LIMIT $3
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;

  return {
    async insert(rows, tx) {
      await delegateOf(tx ?? client, model).createMany({ data: rows });
    },
    async claim(limit, now) {
      const claimedUntil = new Date(now.getTime() + claimTimeoutMs);
      const raw = (await client.$queryRawUnsafe(
        claimSql,
        claimedUntil,
        now,
        limit,
      )) as Record<string, unknown>[];
      // nextAttemptAt on the returned rows is the bumped claim horizon, not
      // the original schedule — the worker never reads it, hooks might.
      return raw.map(
        (row): OutboxRow => ({
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
        }),
      );
    },
    async complete(rowId) {
      await delegateOf(client, model).updateMany({
        where: { id: rowId },
        data: { status: "delivered" },
      });
    },
    async retry(rowId, attempts, nextAttemptAt, lastError) {
      await delegateOf(client, model).updateMany({
        where: { id: rowId },
        data: { attempts, nextAttemptAt, lastError },
      });
    },
    async dead(rowId, attempts, lastError) {
      await delegateOf(client, model).updateMany({
        where: { id: rowId },
        data: { status: "dead", attempts, lastError },
      });
    },
  };
}
