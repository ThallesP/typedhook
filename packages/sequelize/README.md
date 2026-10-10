# @thallesp/webhooks-sequelize

Sequelize v6 outbox adapter for [`@thallesp/webhooks`](https://www.npmjs.com/package/@thallesp/webhooks). Claiming is atomic (`FOR UPDATE SKIP LOCKED` on Postgres and MySQL), so you can run any number of concurrent workers without double delivery.

**Postgres, MySQL 8+ and SQLite 3.35+.** Other dialects throw at startup.

## Install

```sh
npm install @thallesp/webhooks @thallesp/webhooks-sequelize sequelize
```

Plus your Sequelize driver (`pg`, `mysql2` or `sqlite3`).

## Table

The adapter defines its own model on your Sequelize instance, so `sequelize.sync()` creates the table. With migrations, add this one (column names must stay as they are; the claim query addresses them directly):

```js
module.exports = {
  async up(queryInterface, Sequelize) {
    const isMySql = queryInterface.sequelize.getDialect() === "mysql";
    await queryInterface.createTable("webhook_outbox", {
      id: { type: Sequelize.STRING, primaryKey: true },
      eventId: { type: Sequelize.STRING, allowNull: false },
      eventType: { type: Sequelize.STRING, allowNull: false },
      subject: { type: Sequelize.STRING },
      body: { type: isMySql ? Sequelize.TEXT("long") : Sequelize.TEXT, allowNull: false },
      url: { type: Sequelize.TEXT, allowNull: false },
      secret: { type: Sequelize.STRING },
      attempts: { type: Sequelize.INTEGER, allowNull: false },
      nextAttemptAt: { type: Sequelize.DATE(3), allowNull: false },
      status: { type: Sequelize.STRING, allowNull: false },
      lastError: { type: Sequelize.TEXT },
      createdAt: { type: Sequelize.DATE(3), allowNull: false },
    });
    await queryInterface.addIndex("webhook_outbox", ["status", "nextAttemptAt"]);
  },
  async down(queryInterface) {
    await queryInterface.dropTable("webhook_outbox");
  },
};
```

Or plain SQL. Postgres:

```sql
CREATE TABLE "webhook_outbox" (
  "id"            VARCHAR(255) PRIMARY KEY,
  "eventId"       VARCHAR(255) NOT NULL,
  "eventType"     VARCHAR(255) NOT NULL,
  "subject"       VARCHAR(255),
  "body"          TEXT NOT NULL,
  "url"           TEXT NOT NULL,
  "secret"        VARCHAR(255),
  "attempts"      INTEGER NOT NULL,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
  "status"        VARCHAR(255) NOT NULL,
  "lastError"     TEXT,
  "createdAt"     TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "webhook_outbox_status_next_attempt_at" ON "webhook_outbox" ("status", "nextAttemptAt");
```

MySQL (`DATETIME(3)` matters: without it, milliseconds are dropped):

```sql
CREATE TABLE `webhook_outbox` (
  `id`            VARCHAR(255) NOT NULL PRIMARY KEY,
  `eventId`       VARCHAR(255) NOT NULL,
  `eventType`     VARCHAR(255) NOT NULL,
  `subject`       VARCHAR(255),
  `body`          LONGTEXT NOT NULL,
  `url`           TEXT NOT NULL,
  `secret`        VARCHAR(255),
  `attempts`      INT NOT NULL,
  `nextAttemptAt` DATETIME(3) NOT NULL,
  `status`        VARCHAR(255) NOT NULL,
  `lastError`     TEXT,
  `createdAt`     DATETIME(3) NOT NULL,
  INDEX `webhook_outbox_status_next_attempt_at` (`status`, `nextAttemptAt`)
);
```

SQLite:

```sql
CREATE TABLE "webhook_outbox" (
  "id"            VARCHAR(255) PRIMARY KEY,
  "eventId"       VARCHAR(255) NOT NULL,
  "eventType"     VARCHAR(255) NOT NULL,
  "subject"       VARCHAR(255),
  "body"          TEXT NOT NULL,
  "url"           TEXT NOT NULL,
  "secret"        VARCHAR(255),
  "attempts"      INTEGER NOT NULL,
  "nextAttemptAt" DATETIME NOT NULL,
  "status"        VARCHAR(255) NOT NULL,
  "lastError"     TEXT,
  "createdAt"     DATETIME NOT NULL
);
CREATE INDEX "webhook_outbox_status_next_attempt_at" ON "webhook_outbox" ("status", "nextAttemptAt");
```

Named the table something else? Pass `{ table }` to match.

## Usage

```ts
import { webhooks, outbox } from "@thallesp/webhooks";
import { sequelizeOutboxAdapter } from "@thallesp/webhooks-sequelize";
import { Sequelize } from "sequelize";
import { z } from "zod";

const sequelize = new Sequelize(process.env.DATABASE_URL!);

const wh = webhooks({
  events: { "user.created": z.object({ userId: z.string() }) },
  subscribers: [{ url: "https://consumer.example/hook" }],
  signing: { secret: process.env.WEBHOOK_SECRET! },
  delivery: outbox(sequelizeOutboxAdapter(sequelize)),
});

// Enqueue atomically with your own writes:
await sequelize.transaction(async (tx) => {
  const user = await User.create({ email: "a@b.c" }, { transaction: tx });
  await wh.with(tx).send({
    event: "user.created",
    subject: user.id,
    data: { userId: user.id },
  });
});

// Somewhere long-lived (or cron-driven via .tick()):
wh.worker().start();
```

`wh.with(tx)` takes a Sequelize `Transaction`; the outbox insert runs with `{ transaction: tx }`, so it commits or rolls back with your writes.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `table` | `"webhook_outbox"` | Table name (plain identifier). Also the name of the model the adapter defines. |
| `claimTimeoutMs` | `60000` | How long claimed rows are hidden from other workers. If a worker crashes mid-delivery, its rows become due again after this. Keep it above the worker's `timeoutMs`. |

## Semantics

- Claimed rows stay `status: "pending"`; their `nextAttemptAt` is pushed `claimTimeoutMs` into the future. A crashed worker's rows redeliver after the timeout — delivery is at-least-once, same as the core contract.
- Postgres claims with one `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`. MySQL has no `RETURNING`, so it runs `SELECT ... FOR UPDATE SKIP LOCKED` and the `UPDATE` in one transaction. SQLite runs the same single `UPDATE ... RETURNING` without row locks; SQLite serializes writers.
- `claim` picks the oldest due rows, but a batch isn't returned in any particular order (the worker delivers a batch concurrently).
- `complete`/`retry`/`dead` are `update` calls by id: updating an already-deleted row is a no-op, not an error.
