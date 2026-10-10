# @typedhook/mikro-orm

MikroORM outbox adapter for [`@typedhook/sdk`](https://www.npmjs.com/package/@typedhook/sdk). Claiming uses `FOR UPDATE SKIP LOCKED`, so you can run any number of concurrent workers without double delivery.

**Postgres and MySQL 8+**, on MikroORM 6 or 7. SQLite works on MikroORM 7 (see [Semantics](#semantics)).

## Install

```sh
npm install @typedhook/sdk @typedhook/mikro-orm
```

## Entity

Add the exported `WebhookOutbox` entity (an `EntitySchema`, no decorators) to your config:

```ts
import { WebhookOutbox } from "@typedhook/mikro-orm";

const orm = await MikroORM.init({
  entities: [User, WebhookOutbox],
  // ...
});
```

Then create the table with your migrations, or copy the SQL for your database. Column names below follow MikroORM's default naming strategy; with a custom one, generate the migration instead.

Postgres:

```sql
create table "webhook_outbox" ("id" varchar(255) not null, "event_id" varchar(255) not null, "event_type" varchar(255) not null, "subject" varchar(255) null, "body" text not null, "url" text not null, "secret" text null, "attempts" int not null, "next_attempt_at" timestamptz(3) not null, "status" varchar(255) not null, "last_error" text null, "created_at" timestamptz(3) not null, primary key ("id"));
create index "webhook_outbox_status_next_attempt_at_index" on "webhook_outbox" ("status", "next_attempt_at");
```

MySQL:

```sql
create table `webhook_outbox` (`id` varchar(255) not null, `event_id` varchar(255) not null, `event_type` varchar(255) not null, `subject` varchar(255) null, `body` longtext not null, `url` text not null, `secret` text null, `attempts` int not null, `next_attempt_at` datetime(3) not null, `status` varchar(255) not null, `last_error` text null, `created_at` datetime(3) not null, primary key (`id`)) default character set utf8mb4 engine = InnoDB;
alter table `webhook_outbox` add index `webhook_outbox_status_next_attempt_at_index` (`status`, `next_attempt_at`);
```

SQLite:

```sql
create table `webhook_outbox` (`id` text not null primary key, `event_id` text not null, `event_type` text not null, `subject` text null, `body` text not null, `url` text not null, `secret` text null, `attempts` integer not null, `next_attempt_at` datetime not null, `status` text not null, `last_error` text null, `created_at` datetime not null);
create index `webhook_outbox_status_next_attempt_at_index` on `webhook_outbox` (`status`, `next_attempt_at`);
```

`body` is `longtext` on MySQL (its `text` stops at 64 KB) and `text` elsewhere; the entity picks the right one for your driver.

Want another table name? Build the entity with `webhookOutboxSchema({ tableName: "outbox" })`, register that one instead, and pass it to the adapter as `{ entity }`.

## Usage

```ts
import { webhooks, outbox } from "@typedhook/sdk";
import { mikroOrmOutboxAdapter } from "@typedhook/mikro-orm";
import { MikroORM, type EntityManager } from "@mikro-orm/postgresql";
import { z } from "zod";

const orm = await MikroORM.init(config);

const wh = webhooks({
  events: { "user.created": z.object({ userId: z.string() }) },
  subscribers: [{ url: "https://consumer.example/hook" }],
  signing: { secret: process.env.WEBHOOK_SECRET! },
  delivery: outbox(mikroOrmOutboxAdapter<EntityManager>(orm.em)),
});

// Enqueue atomically with your own writes:
await orm.em.transactional(async (em) => {
  const user = em.create(User, { email: "a@b.c" });
  await em.flush();
  await wh.with(em).send({
    event: "user.created",
    subject: user.id,
    data: { userId: user.id },
  });
});

// Somewhere long-lived (or cron-driven via .tick()):
wh.worker().start();
```

`with(em)` takes the `EntityManager` that `transactional` hands you. The row is inserted right away on that transaction (not queued for a flush), so it commits or rolls back with your writes.

## Options

`mikroOrmOutboxAdapter(em, options)`:

| Option | Default | Meaning |
| --- | --- | --- |
| `entity` | `WebhookOutbox` | The outbox entity you registered. Pass the result of `webhookOutboxSchema(...)` if you renamed the table. |
| `claimTimeoutMs` | `60000` | How long claimed rows are hidden from other workers. If a worker crashes mid-delivery, its rows become due again after this. Keep it above the worker's `timeoutMs`. |

`webhookOutboxSchema(options)`:

| Option | Default | Meaning |
| --- | --- | --- |
| `tableName` | `"webhook_outbox"` | Table name, a plain SQL identifier |

## Semantics

- `claim` runs in its own transaction: `SELECT ... FOR UPDATE SKIP LOCKED`, then one `UPDATE` that pushes `nextAttemptAt` `claimTimeoutMs` into the future, then commit. Claimed rows stay `status: "pending"`. A crashed worker's rows redeliver after the timeout — delivery is at-least-once, same as the core contract.
- `complete`/`retry`/`dead` are `nativeUpdate` calls by id: updating an already-deleted row is a no-op, not an error.
- Calls without a transaction (`send()` without `with`, the worker) run on a fork of the `em` you passed, so the global `EntityManager` is fine to pass.
- SQLite has no row locks. MikroORM 7 drops the lock clause and SQLite lets one writer in at a time, so claims still don't overlap. MikroORM uses one SQLite connection, so inside a `transactional` callback always go through `with(em)`: a call outside the transaction would wait for the connection the callback holds, forever. MikroORM 6 rejects `SKIP LOCKED` on SQLite.
