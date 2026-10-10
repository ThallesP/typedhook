# @thallesp/webhooks-typeorm

TypeORM outbox adapter for [`@thallesp/webhooks`](https://www.npmjs.com/package/@thallesp/webhooks). Claiming uses `FOR UPDATE SKIP LOCKED`, so you can run any number of concurrent workers without double delivery.

**Postgres and MySQL 8+ only.** SQLite has no `SKIP LOCKED`, and TypeORM runs every SQLite transaction on one shared connection.

## Install

```sh
npm install @thallesp/webhooks @thallesp/webhooks-typeorm
```

## Schema

Add the outbox entity to your DataSource. It's an `EntitySchema`, so you don't need decorators:

```ts
import { DataSource } from "typeorm";
import { webhookOutboxSchema } from "@thallesp/webhooks-typeorm";

export const dataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: [User, webhookOutboxSchema({ type: "postgres" })],
});
```

Then run `typeorm migration:generate`, or copy the SQL for your database into a migration.

Postgres:

```sql
CREATE TABLE "webhook_outbox" (
  "id" varchar(255) PRIMARY KEY,
  "eventId" varchar(255) NOT NULL,
  "eventType" varchar(255) NOT NULL,
  "subject" varchar(255),
  "body" text NOT NULL,
  "url" text NOT NULL,
  "secret" text,
  "attempts" integer NOT NULL,
  "nextAttemptAt" timestamptz NOT NULL,
  "status" varchar(255) NOT NULL,
  "lastError" text,
  "createdAt" timestamptz NOT NULL
);
CREATE INDEX "webhook_outbox_status_nextAttemptAt_idx" ON "webhook_outbox" ("status", "nextAttemptAt");
```

MySQL:

```sql
CREATE TABLE `webhook_outbox` (
  `id` varchar(255) NOT NULL PRIMARY KEY,
  `eventId` varchar(255) NOT NULL,
  `eventType` varchar(255) NOT NULL,
  `subject` varchar(255) NULL,
  `body` longtext NOT NULL,
  `url` text NOT NULL,
  `secret` text NULL,
  `attempts` int NOT NULL,
  `nextAttemptAt` datetime(3) NOT NULL,
  `status` varchar(255) NOT NULL,
  `lastError` text NULL,
  `createdAt` datetime(3) NOT NULL,
  INDEX `webhook_outbox_status_nextAttemptAt_idx` (`status`, `nextAttemptAt`)
);
```

On MySQL, set `timezone: "Z"` on the DataSource. `datetime` has no time zone, so every app and worker has to read and write it in the same one.

The SQL uses TypeORM's default column names. If you use a custom naming strategy, generate the migration instead. The adapter goes through the entity metadata, so it works with any naming strategy.

## Usage

```ts
import { webhooks, outbox } from "@thallesp/webhooks";
import { typeormOutboxAdapter } from "@thallesp/webhooks-typeorm";
import { z } from "zod";
import { dataSource } from "./data-source";

const wh = webhooks({
  events: { "user.created": z.object({ userId: z.string() }) },
  subscribers: [{ url: "https://consumer.example/hook" }],
  signing: { secret: process.env.WEBHOOK_SECRET! },
  delivery: outbox(typeormOutboxAdapter(dataSource)),
});

// Enqueue atomically with your own writes:
await dataSource.transaction(async (manager) => {
  const user = await manager.save(User, { email: "a@b.c" });
  await wh.with(manager).send({
    event: "user.created",
    subject: user.id,
    data: { userId: user.id },
  });
});

// Somewhere long-lived (or cron-driven via .tick()):
wh.worker().start();
```

`wh.with()` takes the `EntityManager` that `dataSource.transaction` gives you.

## Options

`webhookOutboxSchema(options)`:

| Option | Default | Meaning |
| --- | --- | --- |
| `type` | required | `"postgres"` or `"mysql"`, same as your DataSource. Picks the timestamp and long-text column types |
| `table` | `"webhook_outbox"` | Table and entity name |

`typeormOutboxAdapter(dataSource, options)`:

| Option | Default | Meaning |
| --- | --- | --- |
| `table` | `"webhook_outbox"` | Table name. Must match the one passed to `webhookOutboxSchema` |
| `claimTimeoutMs` | `60000` | How long claimed rows are hidden from other workers. If a worker crashes mid-delivery, its rows become due again after this. Keep it above the worker's `timeoutMs`. |

## Semantics

- `claim` runs one `READ COMMITTED` transaction. It selects due rows `FOR UPDATE SKIP LOCKED` and pushes their `nextAttemptAt` `claimTimeoutMs` into the future.
- Claimed rows stay `status: "pending"`. A crashed worker's rows redeliver after the timeout, so delivery is at-least-once, same as the core contract.
- `complete`/`retry`/`dead` update by id. Updating a row that no longer exists is a no-op, not an error.
