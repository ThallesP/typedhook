# @thallesp/webhooks-knex

Knex outbox adapter for [`@thallesp/webhooks`](https://www.npmjs.com/package/@thallesp/webhooks). Works with Postgres, MySQL 8+ and SQLite. On Postgres and MySQL, claiming uses `FOR UPDATE SKIP LOCKED`, so you can run any number of concurrent workers without double delivery.

## Install

```sh
npm install @thallesp/webhooks @thallesp/webhooks-knex knex
```

Plus your driver (`pg`, `mysql2`, `sqlite3` or `better-sqlite3`).

## Table

A knex migration that works on all three databases:

```ts
import type { Knex } from "knex";

export async function up(knex: Knex) {
  await knex.schema.createTable("webhook_outbox", (table) => {
    table.string("id").primary();
    table.string("eventId").notNullable();
    table.string("eventType").notNullable();
    table.text("subject");
    table.text("body", "longtext").notNullable();
    table.text("url").notNullable();
    table.text("secret");
    table.integer("attempts").notNullable();
    table.datetime("nextAttemptAt", { precision: 3 }).notNullable();
    table.string("status", 16).notNullable();
    table.text("lastError");
    table.datetime("createdAt", { precision: 3 }).notNullable();
    table.index(["status", "nextAttemptAt"]);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTable("webhook_outbox");
}
```

Or the same table in raw SQL. Postgres:

```sql
CREATE TABLE "webhook_outbox" (
  "id"            varchar(255) PRIMARY KEY,
  "eventId"       varchar(255) NOT NULL,
  "eventType"     varchar(255) NOT NULL,
  "subject"       text,
  "body"          text NOT NULL,
  "url"           text NOT NULL,
  "secret"        text,
  "attempts"      integer NOT NULL,
  "nextAttemptAt" timestamptz(3) NOT NULL,
  "status"        varchar(16) NOT NULL,
  "lastError"     text,
  "createdAt"     timestamptz(3) NOT NULL
);
CREATE INDEX "webhook_outbox_status_nextattemptat_index" ON "webhook_outbox" ("status", "nextAttemptAt");
```

MySQL:

```sql
CREATE TABLE `webhook_outbox` (
  `id`            varchar(255) PRIMARY KEY,
  `eventId`       varchar(255) NOT NULL,
  `eventType`     varchar(255) NOT NULL,
  `subject`       text,
  `body`          longtext NOT NULL,
  `url`           text NOT NULL,
  `secret`        text,
  `attempts`      int NOT NULL,
  `nextAttemptAt` datetime(3) NOT NULL,
  `status`        varchar(16) NOT NULL,
  `lastError`     text,
  `createdAt`     datetime(3) NOT NULL,
  INDEX `webhook_outbox_status_nextattemptat_index` (`status`, `nextAttemptAt`)
);
```

SQLite (knex's SQLite drivers store dates as epoch milliseconds):

```sql
CREATE TABLE `webhook_outbox` (
  `id`            varchar(255) PRIMARY KEY,
  `eventId`       varchar(255) NOT NULL,
  `eventType`     varchar(255) NOT NULL,
  `subject`       text,
  `body`          text NOT NULL,
  `url`           text NOT NULL,
  `secret`        text,
  `attempts`      integer NOT NULL,
  `nextAttemptAt` datetime NOT NULL,
  `status`        varchar(16) NOT NULL,
  `lastError`     text,
  `createdAt`     datetime NOT NULL
);
CREATE INDEX `webhook_outbox_status_nextattemptat_index` ON `webhook_outbox` (`status`, `nextAttemptAt`);
```

Column names must stay as written (camelCase, matching the outbox row). Different table name? Pass `{ table }`.

## Usage

```ts
import { webhooks, outbox } from "@thallesp/webhooks";
import { knexOutboxAdapter } from "@thallesp/webhooks-knex";
import knex from "knex";
import { z } from "zod";

const db = knex({ client: "pg", connection: process.env.DATABASE_URL });

const wh = webhooks({
  events: { "user.created": z.object({ userId: z.string() }) },
  subscribers: [{ url: "https://consumer.example/hook" }],
  signing: { secret: process.env.WEBHOOK_SECRET! },
  delivery: outbox(knexOutboxAdapter(db)),
});

// Enqueue atomically with your own writes:
await db.transaction(async (trx) => {
  const [user] = await trx("users").insert({ email: "a@b.c" }).returning("*");
  await wh.with(trx).send({
    event: "user.created",
    subject: user.id,
    data: { userId: user.id },
  });
});

// Somewhere long-lived (or cron-driven via .tick()):
wh.worker().start();
```

`with(tx)` takes a `Knex.Transaction`. Without it, `send()` inserts through the `db` you passed in.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `table` | `"webhook_outbox"` | Outbox table name |
| `claimTimeoutMs` | `60000` | How long claimed rows are hidden from other workers. If a worker crashes mid-delivery, its rows become due again after this. Keep it above the worker's `timeoutMs`. |

## Semantics

- `claim` runs in its own transaction: it selects the earliest due rows (`FOR UPDATE SKIP LOCKED` on Postgres and MySQL), then pushes their `nextAttemptAt` `claimTimeoutMs` into the future. Claimed rows stay `status: "pending"`. A crashed worker's rows redeliver after the timeout — delivery is at-least-once, same as the core contract.
- SQLite has no row locks; claims stay apart because SQLite allows one writer at a time. Within one process knex runs SQLite on a single connection, so claims simply queue. Across processes, a claim that loses the race fails with `SQLITE_BUSY` and the worker tries again on its next tick. Use Postgres or MySQL for many workers.
- `complete`/`retry`/`dead` update by id: updating an already-deleted row is a no-op, not an error.
