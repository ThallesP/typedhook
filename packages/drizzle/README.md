# @typedhook/drizzle

Drizzle outbox adapter for [`@typedhook/sdk`](https://www.npmjs.com/package/@typedhook/sdk). Works with Postgres, MySQL 8+ and SQLite. Claiming is atomic, so you can run any number of concurrent workers without double delivery.

## Install

```sh
npm install @typedhook/sdk @typedhook/drizzle
```

Needs `drizzle-orm` 0.44 or later (1.0 is not supported yet).

## Table

Paste the table for your dialect into your Drizzle schema and generate a migration with drizzle-kit. Rename the table and the SQL column names as you like, but keep the property names (`id`, `eventId`, `nextAttemptAt`, ...): the adapter reads and writes through them.

### Postgres

```ts
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const webhookOutbox = pgTable(
  "webhook_outbox",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    url: text("url").notNull(),
    secret: text("secret"),
    attempts: integer("attempts").notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["pending", "delivered", "dead"] }).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("webhook_outbox_due_idx").on(table.status, table.nextAttemptAt)],
);
```

### MySQL

```ts
import { datetime, index, int, longtext, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";

export const webhookOutbox = mysqlTable(
  "webhook_outbox",
  {
    id: varchar("id", { length: 255 }).primaryKey(),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    eventType: varchar("event_type", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 255 }),
    body: longtext("body").notNull(),
    url: text("url").notNull(),
    secret: text("secret"),
    attempts: int("attempts").notNull(),
    nextAttemptAt: datetime("next_attempt_at", { mode: "date", fsp: 3 }).notNull(),
    status: varchar("status", { length: 16, enum: ["pending", "delivered", "dead"] }).notNull(),
    lastError: text("last_error"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => [index("webhook_outbox_due_idx").on(table.status, table.nextAttemptAt)],
);
```

The `(status, nextAttemptAt)` index matters more on MySQL than elsewhere: without it, a claim locks every due row and your workers take turns instead of running in parallel.

### SQLite

```ts
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const webhookOutbox = sqliteTable(
  "webhook_outbox",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    url: text("url").notNull(),
    secret: text("secret"),
    attempts: integer("attempts").notNull(),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
    status: text("status", { enum: ["pending", "delivered", "dead"] }).notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("webhook_outbox_due_idx").on(table.status, table.nextAttemptAt)],
);
```

## Usage

```ts
import { webhooks, outbox } from "@typedhook/sdk";
import { drizzleOutboxAdapter } from "@typedhook/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { users, webhookOutbox } from "./schema";

const db = drizzle(process.env.DATABASE_URL!);

const wh = webhooks({
  events: { "user.created": z.object({ userId: z.string() }) },
  subscribers: [{ url: "https://consumer.example/hook" }],
  signing: { secret: process.env.WEBHOOK_SECRET! },
  delivery: outbox(drizzleOutboxAdapter(db, { table: webhookOutbox })),
});

// Enqueue atomically with your own writes:
await db.transaction(async (tx) => {
  const [user] = await tx.insert(users).values({ email: "a@b.c" }).returning();
  await wh.with(tx).send({
    event: "user.created",
    subject: user.id,
    data: { userId: user.id },
  });
});

// Somewhere long-lived (or cron-driven via .tick()):
wh.worker().start();
```

MySQL and SQLite look the same: pass your `drizzle(...)` db and the table for that dialect. The transaction type comes from `db`, so `wh.with(tx)` only accepts a transaction from that database.

### Sync SQLite drivers

`bun:sqlite` and `better-sqlite3` are synchronous, and Drizzle can't await inside their `db.transaction(...)`. Open the transaction yourself and pass the db:

```ts
import { sql } from "drizzle-orm";

db.run(sql`BEGIN IMMEDIATE`);
try {
  await wh.with(db).send({ event: "user.created", subject: user.id, data: { userId: user.id } });
  db.run(sql`COMMIT`);
} catch (error) {
  db.run(sql`ROLLBACK`);
  throw error;
}
```

Async drivers (libsql, Turso) use `db.transaction(async (tx) => ...)` as usual. Give the worker its own connection (for a sync driver, a separate `drizzle(...)` on the same file) so its queries don't land inside your open transaction, and set `PRAGMA busy_timeout` so concurrent writers wait instead of failing with `SQLITE_BUSY`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `table` | required | Your outbox table (`pgTable`, `mysqlTable` or `sqliteTable`, matching `db`) |
| `claimTimeoutMs` | `60000` | How long claimed rows are hidden from other workers. If a worker crashes mid-delivery, its rows become due again after this. Keep it above the worker's `timeoutMs`. |

## Semantics

- Postgres claims with one `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`.
- MySQL has no `RETURNING`, so a claim is a short `READ COMMITTED` transaction: select the due ids `FOR UPDATE SKIP LOCKED`, update them, read them back.
- SQLite allows one writer at a time, so a single `UPDATE ... RETURNING` is atomic on its own.
- Claimed rows stay `status: "pending"`; their `nextAttemptAt` is pushed `claimTimeoutMs` into the future. A crashed worker's rows redeliver after the timeout — delivery is at-least-once, same as the core contract.
- `complete`/`retry`/`dead` update by id: updating an already-deleted row is a no-op, not an error.
