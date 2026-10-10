import type { OutboxAdapter, OutboxRow } from "@typedhook/sdk";
import {
  DataTypes,
  QueryTypes,
  type Model,
  type ModelStatic,
  type Sequelize,
  type Transaction,
} from "sequelize";

export interface SequelizeAdapterOptions {
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

function defineOutbox(sequelize: Sequelize, table: string): ModelStatic<Model<OutboxRow>> {
  return sequelize.define<Model<OutboxRow>>(
    table,
    {
      id: { type: DataTypes.STRING, primaryKey: true },
      eventId: { type: DataTypes.STRING, allowNull: false },
      eventType: { type: DataTypes.STRING, allowNull: false },
      subject: { type: DataTypes.STRING },
      // Plain TEXT caps at 64 KB on MySQL; other dialects warn on TEXT("long").
      body: {
        type: sequelize.getDialect() === "mysql" ? DataTypes.TEXT("long") : DataTypes.TEXT,
        allowNull: false,
      },
      url: { type: DataTypes.TEXT, allowNull: false },
      secret: { type: DataTypes.STRING },
      attempts: { type: DataTypes.INTEGER, allowNull: false },
      nextAttemptAt: { type: DataTypes.DATE(3), allowNull: false },
      status: { type: DataTypes.STRING, allowNull: false },
      lastError: { type: DataTypes.TEXT },
      createdAt: { type: DataTypes.DATE(3), allowNull: false },
    },
    {
      tableName: table,
      timestamps: false,
      indexes: [{ fields: ["status", "nextAttemptAt"] }],
    },
  );
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

function toOutboxRow(row: Record<string, unknown>): OutboxRow {
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

/**
 * Postgres, MySQL 8+ and SQLite. The adapter defines its own model on your
 * Sequelize instance (see the README for the table to create). Rows stay
 * `pending` while claimed; their nextAttemptAt is pushed claimTimeoutMs into
 * the future, so a crashed worker's rows are redelivered after the timeout
 * (at-least-once).
 *
 * `with(tx)` takes a Sequelize Transaction; the insert joins it.
 */
export function sequelizeOutboxAdapter<Tx extends Transaction = Transaction>(
  sequelize: Sequelize,
  options: SequelizeAdapterOptions = {},
): OutboxAdapter<Tx> {
  const table = options.table ?? "webhook_outbox";
  const claimTimeoutMs = options.claimTimeoutMs ?? 60_000;
  const dialect = sequelize.getDialect();
  if (!IDENTIFIER.test(table)) {
    throw new Error(`invalid table name "${table}": must be a plain SQL identifier`);
  }
  if (!["postgres", "mysql", "sqlite"].includes(dialect)) {
    throw new Error(`unsupported dialect "${dialect}": use postgres, mysql or sqlite`);
  }

  const outbox = defineOutbox(sequelize, table);

  // One statement, so the pick and the bump are atomic. SQLite has no row
  // locks, but it serializes writers, so it doesn't need SKIP LOCKED.
  const claimSql = `
    UPDATE "${table}" SET "nextAttemptAt" = :claimedUntil
    WHERE "id" IN (
      SELECT "id" FROM "${table}"
      WHERE "status" = 'pending' AND "nextAttemptAt" <= :now
      ORDER BY "nextAttemptAt"
      LIMIT :limit
      ${dialect === "postgres" ? "FOR UPDATE SKIP LOCKED" : ""}
    )
    RETURNING *`;

  // MySQL has no UPDATE ... RETURNING (and no LIMIT in an IN subquery), so
  // lock the due rows and bump them in one transaction instead. Raw SQL
  // because Sequelize v6 silently drops `skipLocked` on MySQL, and plain
  // FOR UPDATE deadlocks concurrent claimers. Bound, not replaced: Sequelize
  // formats replacement dates without milliseconds on MySQL.
  const lockSql = `
    SELECT * FROM \`${table}\`
    WHERE \`status\` = 'pending' AND \`nextAttemptAt\` <= $1
    ORDER BY \`nextAttemptAt\`
    LIMIT $2
    FOR UPDATE SKIP LOCKED`;

  async function claimWithLock(limit: number, now: Date, claimedUntil: Date) {
    return sequelize.transaction(async (transaction) => {
      const due = await sequelize.query<Record<string, unknown>>(lockSql, {
        bind: [now, limit],
        type: QueryTypes.SELECT,
        transaction,
      });
      if (due.length === 0) return [];

      const ids = due.map((row) => String(row.id));
      await outbox.update({ nextAttemptAt: claimedUntil }, { where: { id: ids }, transaction });
      return due.map((row) => ({ ...toOutboxRow(row), nextAttemptAt: claimedUntil }));
    });
  }

  return {
    async insert(rows, tx) {
      await outbox.bulkCreate(rows, { transaction: tx });
    },
    async claim(limit, now) {
      const claimedUntil = new Date(now.getTime() + claimTimeoutMs);
      if (dialect === "mysql") return claimWithLock(limit, now, claimedUntil);

      const raw = await sequelize.query<Record<string, unknown>>(claimSql, {
        replacements: { claimedUntil, now, limit },
        type: QueryTypes.SELECT,
      });
      // nextAttemptAt on the returned rows is the bumped claim horizon, not
      // the original schedule — the worker never reads it, hooks might.
      return raw.map(toOutboxRow);
    },
    async complete(rowId) {
      await outbox.update({ status: "delivered" }, { where: { id: rowId } });
    },
    async retry(rowId, attempts, nextAttemptAt, lastError) {
      await outbox.update({ attempts, nextAttemptAt, lastError }, { where: { id: rowId } });
    },
    async dead(rowId, attempts, lastError) {
      await outbox.update({ status: "dead", attempts, lastError }, { where: { id: rowId } });
    },
  };
}
