# @thallesp/webhooks-kysely

[Kysely](https://kysely.dev) outbox adapter for [`@thallesp/webhooks`](https://www.npmjs.com/package/@thallesp/webhooks). Works on Postgres, MySQL 8+ and SQLite. Claiming is safe with any number of concurrent workers.

## Install

```sh
npm install @thallesp/webhooks @thallesp/webhooks-kysely kysely
```

## Table

Create it in a migration. Column names are camelCase; if you use `CamelCasePlugin`, create them in snake_case instead (`event_id`, `next_attempt_at`, …) and the plugin maps them.

Postgres:

```sql
CREATE TABLE webhook_outbox (
  "id"            text PRIMARY KEY,
  "eventId"       text NOT NULL,
  "eventType"     text NOT NULL,
  "subject"       text,
  "body"          text NOT NULL,
  "url"           text NOT NULL,
  "secret"        text,
  "attempts"      integer NOT NULL,
  "nextAttemptAt" timestamptz NOT NULL,
  "status"        text NOT NULL,
  "lastError"     text,
  "createdAt"     timestamptz NOT NULL
);
CREATE INDEX webhook_outbox_due ON webhook_outbox ("status", "nextAttemptAt");
```

MySQL 8+:

```sql
CREATE TABLE webhook_outbox (
  id            varchar(255) PRIMARY KEY,
  eventId       varchar(255) NOT NULL,
  eventType     varchar(255) NOT NULL,
  subject       varchar(255) NULL,
  body          longtext NOT NULL,
  url           text NOT NULL,
  secret        text NULL,
  attempts      int NOT NULL,
  nextAttemptAt datetime(3) NOT NULL,
  status        varchar(16) NOT NULL,
  lastError     text NULL,
  createdAt     datetime(3) NOT NULL,
  INDEX webhook_outbox_due (status, nextAttemptAt)
);
```

SQLite (dates are stored as ISO-8601 text):

```sql
CREATE TABLE webhook_outbox (
  id            TEXT PRIMARY KEY,
  eventId       TEXT NOT NULL,
  eventType     TEXT NOT NULL,
  subject       TEXT,
  body          TEXT NOT NULL,
  url           TEXT NOT NULL,
  secret        TEXT,
  attempts      INTEGER NOT NULL,
  nextAttemptAt TEXT NOT NULL,
  status        TEXT NOT NULL,
  lastError     TEXT,
  createdAt     TEXT NOT NULL
);
CREATE INDEX webhook_outbox_due ON webhook_outbox (status, nextAttemptAt);
```

Add the table to your `DB` type:

```ts
import type { WebhookOutboxDatabase } from "@thallesp/webhooks-kysely";

interface DB extends WebhookOutboxDatabase {
  users: UserTable;
}
```

Renamed the table? Pass `{ table }` to the adapter and `WebhookOutboxDatabase<"my_table">`. On SQLite use `WebhookOutboxDatabase<"webhook_outbox", string>`.

## Usage

```ts
import { webhooks, outbox } from "@thallesp/webhooks";
import { kyselyOutboxAdapter } from "@thallesp/webhooks-kysely";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { z } from "zod";

const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool() }) });

const wh = webhooks({
  events: { "user.created": z.object({ userId: z.string() }) },
  subscribers: [{ url: "https://consumer.example/hook" }],
  signing: { secret: process.env.WEBHOOK_SECRET! },
  delivery: outbox(kyselyOutboxAdapter(db, { dialect: "postgres" })),
});

// Enqueue atomically with your own writes. wh.with() takes a Transaction<DB>.
await db.transaction().execute(async (trx) => {
  const user = await trx
    .insertInto("users")
    .values({ id: "u_1", email: "a@b.c" })
    .returningAll()
    .executeTakeFirstOrThrow();
  await wh.with(trx).send({
    event: "user.created",
    subject: user.id,
    data: { userId: user.id },
  });
});

// Somewhere long-lived (or cron-driven via .tick()):
wh.worker().start();
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `dialect` | required | `"postgres"`, `"mysql"` or `"sqlite"`. Picks the claim query. |
| `table` | `"webhook_outbox"` | Outbox table name |
| `claimTimeoutMs` | `60000` | How long claimed rows are hidden from other workers. If a worker crashes mid-delivery, its rows become due again after this. Keep it above the worker's `timeoutMs`. |

## Semantics

- Postgres: one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *`.
- MySQL has no `RETURNING`, so claim runs `SELECT … FOR UPDATE SKIP LOCKED` and then `UPDATE` in one transaction.
- SQLite has no `SKIP LOCKED`; claim is one `UPDATE … RETURNING *`, which is atomic because SQLite has a single writer. Set `PRAGMA busy_timeout` if several processes share the file.
- Claimed rows stay `status: "pending"`; their `nextAttemptAt` is pushed `claimTimeoutMs` into the future. A crashed worker's rows redeliver after the timeout — delivery is at-least-once, same as the core contract.
- `complete`/`retry`/`dead` update by id: updating an already-deleted row is a no-op, not an error.
- MySQL: dates go through your driver's timezone setting (mysql2 defaults to local time). Use the same setting in every process that writes the outbox, e.g. `timezone: "Z"`.
