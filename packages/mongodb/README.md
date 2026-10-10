# @typedhook/mongodb

MongoDB outbox adapter for [`@typedhook/sdk`](https://www.npmjs.com/package/@typedhook/sdk). MongoDB has no `SKIP LOCKED`, so each row is claimed with its own atomic `findOneAndUpdate`. You can run any number of concurrent workers without double delivery.

Uses the official [`mongodb`](https://www.npmjs.com/package/mongodb) driver, v6 or v7.

## Install

```sh
npm install @typedhook/sdk @typedhook/mongodb mongodb
```

## Indexes

Rows live in one collection (default `webhookOutbox`). The row id is stored as `_id`, so it's already unique and needs no index of its own. Create the index the claim query uses:

```ts
await db.collection("webhookOutbox").createIndex({ status: 1, nextAttemptAt: 1 });
```

A stored document looks like this:

```ts
{
  _id: "obx_…",          // the row id
  eventId: "evt_…",
  eventType: "user.created",
  subject: "u_1",        // or null
  body: "{…}",           // the exact JSON that gets signed and sent
  url: "https://consumer.example/hook",
  secret: null,
  attempts: 0,
  nextAttemptAt: ISODate("…"),
  status: "pending",     // "pending" | "delivered" | "dead"
  lastError: null,
  createdAt: ISODate("…"),
}
```

## Usage

Transactions need a replica set (a single-node one is fine for local dev) or a sharded cluster. A standalone `mongod` can't run them.

```ts
import { webhooks, outbox } from "@typedhook/sdk";
import { mongodbOutboxAdapter } from "@typedhook/mongodb";
import { MongoClient } from "mongodb";
import { z } from "zod";

const client = await MongoClient.connect(process.env.MONGO_URL!);
const db = client.db("app");

const wh = webhooks({
  events: { "user.created": z.object({ userId: z.string() }) },
  subscribers: [{ url: "https://consumer.example/hook" }],
  signing: { secret: process.env.WEBHOOK_SECRET! },
  delivery: outbox(mongodbOutboxAdapter(db)),
});

// Enqueue atomically with your own writes:
await client.withSession((session) =>
  session.withTransaction(async () => {
    const { insertedId } = await db.collection("users").insertOne({ email: "a@b.c" }, { session });
    await wh.with(session).send({
      event: "user.created",
      subject: insertedId.toString(),
      data: { userId: insertedId.toString() },
    });
  }),
);

// Somewhere long-lived (or cron-driven via .tick()):
wh.worker().start();
```

`wh.with()` takes the `ClientSession`. Without it, `send()` inserts outside any transaction.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `collection` | `"webhookOutbox"` | Collection holding the outbox rows |
| `claimTimeoutMs` | `60000` | How long claimed rows are hidden from other workers. If a worker crashes mid-delivery, its rows become due again after this. Keep it above the worker's `timeoutMs`. |

## Semantics

- `claim(limit)` runs up to `limit` `findOneAndUpdate` calls, each matching `{ status: "pending", nextAttemptAt: { $lte: now } }` sorted by `nextAttemptAt`, and stops at the first miss. That's one round trip per row, so keep the worker's `batch` modest.
- Claimed rows stay `status: "pending"`; their `nextAttemptAt` is pushed `claimTimeoutMs` into the future. A crashed worker's rows redeliver after the timeout — delivery is at-least-once, same as the core contract.
- `complete`/`retry`/`dead` are `updateOne` calls by `_id`: updating an already-deleted row is a no-op, not an error.
