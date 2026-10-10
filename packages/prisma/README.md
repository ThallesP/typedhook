# @typedhook/prisma

Prisma (Postgres) outbox adapter for [`@typedhook/sdk`](https://www.npmjs.com/package/@typedhook/sdk). Claiming uses `FOR UPDATE SKIP LOCKED`, so you can run any number of concurrent workers without double delivery.

**Postgres only** — the claim query is raw SQL.

## Install

```sh
npm install @typedhook/sdk @typedhook/prisma
```

## Schema

Paste into `schema.prisma` (column names must stay Prisma defaults — no `@map`; the raw claim query addresses them directly):

```prisma
model WebhookOutbox {
  id            String   @id
  eventId       String
  eventType     String
  subject       String?
  body          String
  url           String
  secret        String?
  attempts      Int
  nextAttemptAt DateTime
  status        String
  lastError     String?
  createdAt     DateTime

  @@index([status, nextAttemptAt])
}
```

Renamed the model or mapped the table? Pass `{ model, table }` to match.

## Usage

```ts
import { webhooks, outbox } from "@typedhook/sdk";
import { prismaOutboxAdapter } from "@typedhook/prisma";
import { PrismaClient, type Prisma } from "@prisma/client";
import { z } from "zod";

const prisma = new PrismaClient();

const wh = webhooks({
  events: { "user.created": z.object({ userId: z.string() }) },
  subscribers: [{ url: "https://consumer.example/hook" }],
  signing: { secret: process.env.WEBHOOK_SECRET! },
  delivery: outbox(prismaOutboxAdapter<Prisma.TransactionClient>(prisma)),
});

// Enqueue atomically with your own writes:
await prisma.$transaction(async (tx) => {
  const user = await tx.user.create({ data: { email: "a@b.c" } });
  await wh.with(tx).send({
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
| `model` | `"webhookOutbox"` | Property on the client holding the model delegate |
| `table` | `"WebhookOutbox"` | Table name used by the raw claim query |
| `claimTimeoutMs` | `60000` | How long claimed rows are hidden from other workers. If a worker crashes mid-delivery, its rows become due again after this. Keep it above the worker's `timeoutMs`. |

## Semantics

- Claimed rows stay `status: "pending"`; their `nextAttemptAt` is pushed `claimTimeoutMs` into the future. A crashed worker's rows redeliver after the timeout — delivery is at-least-once, same as the core contract.
- `complete`/`retry`/`dead` are `updateMany` calls: updating an already-deleted row is a no-op, not an error.
