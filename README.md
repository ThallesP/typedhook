# webhooks

Type-safe webhooks for TypeScript. Uses the [Standard Webhooks](https://www.standardwebhooks.com/) format.

| Package | Use it to |
| --- | --- |
| `@thallesp/webhooks` | Send webhooks |
| `@thallesp/webhooks-verify` | Verify webhooks you receive (zero deps) |
| `@thallesp/webhooks-prisma` | Store the outbox in Postgres with Prisma |
| `@thallesp/webhooks-drizzle` | Store the outbox with Drizzle (Postgres, MySQL, SQLite) |
| `@thallesp/webhooks-kysely` | Store the outbox with Kysely (Postgres, MySQL, SQLite) |
| `@thallesp/webhooks-typeorm` | Store the outbox with TypeORM (Postgres, MySQL) |
| `@thallesp/webhooks-mikro-orm` | Store the outbox with MikroORM (Postgres, MySQL, SQLite) |
| `@thallesp/webhooks-sequelize` | Store the outbox with Sequelize (Postgres, MySQL, SQLite) |
| `@thallesp/webhooks-knex` | Store the outbox with Knex (Postgres, MySQL, SQLite) |
| `@thallesp/webhooks-mongodb` | Store the outbox in MongoDB |

## Sending

```sh
npm install @thallesp/webhooks
```

```ts
import { webhooks } from "@thallesp/webhooks";
import { z } from "zod"; // or valibot, arktype (any Standard Schema)

const wh = webhooks({
  events: {
    "invoice.paid": z.object({ invoiceId: z.string(), amountCents: z.number() }),
  },
  subscribers: async ({ event, subject }) => db.findSubscribers(event, subject),
  signing: { secret: process.env.WEBHOOK_SECRET! },
});

const result = await wh.send({
  event: "invoice.paid",
  subject: "acct_42",
  data: { invoiceId: "inv_1", amountCents: 4200 },
});
if (!result.ok) console.error(result.error);
```

- `subscribers` can be a function or a static array of `{ url, secret? }`. A subscriber's `secret` overrides `signing.secret`.
- `subject` is the entity the event is about (a user, account or row id). It's passed to `subscribers` and included in the signed body. It's required unless you set `subject: "optional"`.
- `send()` returns `{ ok: false, error }` for invalid data, unknown events or a failing resolver instead of throwing.
- By default webhooks are sent right away and retried in memory (`direct({ maxAttempts: 5 })`). Retries are lost if the process crashes. Use the outbox if that matters.
- Redirects are not followed. A 3xx counts as a failed delivery.

## Outbox

The outbox saves events in your database, in the same transaction as your data. A worker sends them later and retries until they succeed.

```sh
npm install @thallesp/webhooks @thallesp/webhooks-prisma
```

```ts
import { webhooks, outbox } from "@thallesp/webhooks";
import { prismaOutboxAdapter } from "@thallesp/webhooks-prisma";
import type { Prisma } from "@prisma/client";

const wh = webhooks({
  events,
  subscribers,
  signing: { secret: process.env.WEBHOOK_SECRET! },
  delivery: outbox(prismaOutboxAdapter<Prisma.TransactionClient>(prisma), { maxAttempts: 20 }),
});

await prisma.$transaction(async (tx) => {
  const invoice = await tx.invoice.create({ data });
  await wh.with(tx).send({
    event: "invoice.paid",
    subject: invoice.accountId,
    data: { invoiceId: invoice.id, amountCents: invoice.total },
  });
});

// In a long-running process, or call wh.worker().tick() from a cron
wh.worker({ pollIntervalMs: 1000, batch: 100 }).start();
```

`wh.with()` and `wh.worker()` only exist when `delivery` is `outbox(...)`. Using them otherwise is a type error.

If the database insert fails, `send()` throws, so your transaction rolls back.

See [`packages/prisma`](packages/prisma/README.md) for the Prisma schema and options.

### Other databases

Each adapter's README has the schema to copy, how to pass your transaction to `wh.with()`, and its options:

| ORM / driver | Package |
| --- | --- |
| Prisma | [`packages/prisma`](packages/prisma/README.md) |
| Drizzle | [`packages/drizzle`](packages/drizzle/README.md) |
| Kysely | [`packages/kysely`](packages/kysely/README.md) |
| TypeORM | [`packages/typeorm`](packages/typeorm/README.md) |
| MikroORM | [`packages/mikro-orm`](packages/mikro-orm/README.md) |
| Sequelize | [`packages/sequelize`](packages/sequelize/README.md) |
| Knex | [`packages/knex`](packages/knex/README.md) |
| MongoDB | [`packages/mongodb`](packages/mongodb/README.md) |

For anything else, write your own adapter:

```ts
interface OutboxAdapter<Tx = unknown> {
  insert: (rows: OutboxRow[], tx?: Tx) => Promise<void>;
  claim: (limit: number, now: Date) => Promise<OutboxRow[]>; // pending rows due by `now`
  complete: (rowId: string) => Promise<void>;
  retry: (rowId: string, attempts: number, nextAttemptAt: Date, lastError: string) => Promise<void>;
  dead: (rowId: string, attempts: number, lastError: string) => Promise<void>;
}
```

If you run more than one worker, `claim` must mark the rows it returns (for example, push `next_attempt_at` forward) so other workers skip them. A lock alone is released before delivery happens. `memoryAdapter()` is included for tests.

## Verifying

```sh
npm install @thallesp/webhooks-verify
```

Works on Node 20+, Bun, Deno, Cloudflare Workers and edge runtimes. It also accepts `svix-*` headers.

```ts
import { createVerifier } from "@thallesp/webhooks-verify";

const verifier = createVerifier(process.env.WEBHOOK_SECRET!);

// Next.js, Hono, Remix, Workers
export async function POST(req: Request) {
  const result = await verifier.verify(req);
  if (!result.ok) return new Response(result.reason, { status: 400 });
  // result.id, result.payload
  return new Response(null, { status: 204 });
}

// Express: use the raw body, parsed JSON breaks the signature
app.post("/hook", express.raw({ type: "application/json" }), async (req, res) => {
  const result = await verifier.verifyPayload(req.body, req.headers);
  res.status(result.ok ? 204 : 400).end();
});
```

`verify()` never throws. On failure, `result.reason` is one of `missing_headers`, `invalid_id`, `invalid_timestamp`, `timestamp_out_of_tolerance` (±300s, change with `toleranceSec`), `invalid_signature`, `invalid_secret`, `unreadable_body` or `invalid_json`. A bad secret or option throws in `createVerifier()`, so it fails at startup.

**Handle duplicates.** Webhooks can arrive more than once and out of order. `result.id` is the same on every retry, so store it and skip ids you've already seen.

Secrets that start with `whsec_` are base64-decoded. Any other secret is used as plain text.

### Typed payloads

Export the event types from the sender and import them as types in the consumer:

```ts
// sender
import type { EventUnion } from "@thallesp/webhooks";
export type Events = EventUnion<typeof events>;

// consumer
import type { Events } from "acme-sdk";

const result = await verifier.verify<Events>(req);
if (result.ok && result.payload.event === "invoice.paid") {
  result.payload.data.amountCents; // number
}
```

Types match the JSON on the wire, so a `z.date()` field is a `string`. The verifier checks who sent the payload, not its shape. Validate it with a schema if you don't fully trust the sender.

## Development

```sh
bun install
bun test
bun run typecheck
```

Adapter tests run against real databases when these are set, and skip otherwise (SQLite always runs in-process):

```sh
WEBHOOKS_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:5432/webhooks_test
WEBHOOKS_TEST_MYSQL_URL=mysql://root:mysql@127.0.0.1:3306/webhooks_test
WEBHOOKS_TEST_MONGO_URL="mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true"
```

CI starts all three; see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## License

MIT
