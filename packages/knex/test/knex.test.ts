import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { outbox, webhooks, type OutboxRow } from "@typedhook/sdk";
import knex, { type Knex } from "knex";
import { z } from "zod";
import { knexOutboxAdapter } from "../src/index";

// CI points every adapter package at the same database, so these tests only
// ever touch tables named after this package.
const TABLE = "outbox_knex";
const CUSTOM_TABLE = "outbox_knex_custom";

interface Dialect {
  name: string;
  isEnabled: boolean;
  config: Knex.Config;
  /** In-memory SQLite is one database per Knex instance, so workers share it. */
  isSingleConnection: boolean;
}

const postgresUrl = process.env.TYPEDHOOK_TEST_POSTGRES_URL;
const mysqlUrl = process.env.TYPEDHOOK_TEST_MYSQL_URL;

const dialects: Dialect[] = [
  {
    name: "postgres",
    isEnabled: Boolean(postgresUrl),
    config: { client: "pg", connection: postgresUrl },
    isSingleConnection: false,
  },
  {
    name: "mysql",
    isEnabled: Boolean(mysqlUrl),
    config: { client: "mysql2", connection: mysqlUrl },
    isSingleConnection: false,
  },
  {
    name: "sqlite",
    isEnabled: true,
    config: { client: "sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true },
    isSingleConnection: true,
  },
];

// Same migration as the README.
async function createOutboxTable(db: Knex, name: string) {
  await db.schema.dropTableIfExists(name);
  await db.schema.createTable(name, (table) => {
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

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: `obx_${crypto.randomUUID()}`,
    eventId: "evt_1",
    eventType: "user.created",
    subject: null,
    body: "{}",
    url: "https://consumer.test/hook",
    secret: null,
    attempts: 0,
    nextAttemptAt: new Date("2026-01-01T00:00:00.123Z"),
    status: "pending",
    lastError: null,
    createdAt: new Date("2026-01-01T00:00:00.456Z"),
    ...overrides,
  };
}

for (const dialect of dialects) {
  describe.skipIf(!dialect.isEnabled)(`knexOutboxAdapter (${dialect.name})`, () => {
    let db: Knex;

    async function stored(table = TABLE) {
      return db(table).select("*").orderBy("id");
    }

    beforeAll(async () => {
      db = knex(dialect.config);
      await createOutboxTable(db, TABLE);
      await createOutboxTable(db, CUSTOM_TABLE);
    });

    afterAll(async () => {
      await db.schema.dropTableIfExists(TABLE);
      await db.schema.dropTableIfExists(CUSTOM_TABLE);
      await db.destroy();
    });

    beforeEach(async () => {
      await db(TABLE).delete();
      await db(CUSTOM_TABLE).delete();
    });

    test("insert without tx writes through the base client", async () => {
      const adapter = knexOutboxAdapter(db, { table: TABLE });
      const pending = row({ subject: "user_1", secret: "s3cret" });

      await adapter.insert([pending]);

      const records = await stored();
      expect(records.length).toBe(1);
      expect(records[0]).toMatchObject({ id: pending.id, subject: "user_1", secret: "s3cret" });
    });

    test("insert inside a committed transaction is visible", async () => {
      const adapter = knexOutboxAdapter(db, { table: TABLE });

      await db.transaction(async (trx) => {
        await adapter.insert([row(), row()], trx);
      });

      expect((await stored()).length).toBe(2);
    });

    test("insert inside a rolled-back transaction leaves no row", async () => {
      const adapter = knexOutboxAdapter(db, { table: TABLE });

      // knex returns a thenable Transaction, not a Promise; expect().rejects
      // needs a real one.
      const rolledBack = Promise.resolve(
        db.transaction(async (trx) => {
          await adapter.insert([row()], trx);
          throw new Error("rollback");
        }),
      );

      await expect(rolledBack).rejects.toThrow("rollback");
      expect((await stored()).length).toBe(0);
    });

    test("claim returns due pending rows, earliest first, up to the limit", async () => {
      const adapter = knexOutboxAdapter(db, { table: TABLE });
      const third = row({ nextAttemptAt: new Date("2026-01-03") });
      const first = row({ nextAttemptAt: new Date("2026-01-01") });
      const second = row({ nextAttemptAt: new Date("2026-01-02") });
      await adapter.insert([
        third,
        first,
        second,
        row({ nextAttemptAt: new Date("2999-01-01") }),
        row({ status: "delivered" }),
        row({ status: "dead" }),
      ]);
      const now = new Date("2026-06-01");

      const firstBatch = await adapter.claim(2, now);
      const secondBatch = await adapter.claim(10, now);

      expect(firstBatch.map((claimed) => claimed.id)).toEqual([first.id, second.id]);
      expect(secondBatch.map((claimed) => claimed.id)).toEqual([third.id]);
    });

    test("claimed rows stay pending and are hidden until claimTimeoutMs passes", async () => {
      const adapter = knexOutboxAdapter(db, { table: TABLE, claimTimeoutMs: 60_000 });
      await adapter.insert([row()]);
      const now = new Date("2026-06-01");

      const claimed = await adapter.claim(10, now);

      expect(claimed.length).toBe(1);
      expect(claimed[0]!.status).toBe("pending");
      expect((await stored())[0].status).toBe("pending");
      expect((await adapter.claim(10, new Date(now.getTime() + 59_000))).length).toBe(0);
      expect((await adapter.claim(10, new Date(now.getTime() + 61_000))).length).toBe(1);
    });

    test("claimed rows come back with every field and real Dates", async () => {
      const adapter = knexOutboxAdapter(db, { table: TABLE });
      const pending = row({ subject: "user_1", secret: "s3cret", attempts: 2, lastError: "boom" });
      await adapter.insert([pending]);
      const now = new Date("2026-06-01");

      const [claimed] = await adapter.claim(1, now);

      expect(claimed).toEqual({ ...pending, nextAttemptAt: new Date(now.getTime() + 60_000) });
      expect(claimed!.createdAt).toBeInstanceOf(Date);
      expect(claimed!.nextAttemptAt).toBeInstanceOf(Date);
    });

    test("concurrent claims never return the same row twice", async () => {
      const adapter = knexOutboxAdapter(db, { table: TABLE });
      const rowCount = 200;
      await adapter.insert(Array.from({ length: rowCount }, () => row()));
      const workers = Array.from({ length: 5 }, () =>
        dialect.isSingleConnection ? db : knex(dialect.config),
      );
      const now = new Date("2026-06-01");

      async function drain(worker: Knex) {
        const workerAdapter = knexOutboxAdapter(worker, { table: TABLE });
        const ids: string[] = [];
        while (true) {
          const claimed = await workerAdapter.claim(7, now);
          if (claimed.length === 0) return ids;
          ids.push(...claimed.map((claimedRow) => claimedRow.id));
        }
      }

      try {
        const ids = (await Promise.all(workers.map(drain))).flat();
        expect(ids.length).toBe(rowCount);
        expect(new Set(ids).size).toBe(rowCount);
      } finally {
        if (!dialect.isSingleConnection) await Promise.all(workers.map((worker) => worker.destroy()));
      }
    });

    test("complete / retry / dead update the row by id", async () => {
      const adapter = knexOutboxAdapter(db, { table: TABLE });
      const pending = row();
      await adapter.insert([pending]);

      const nextAttemptAt = new Date("2026-02-01T00:00:00.789Z");
      await adapter.retry(pending.id, 3, nextAttemptAt, "boom");
      const [retried] = await stored();
      expect(retried).toMatchObject({ attempts: 3, lastError: "boom", status: "pending" });
      expect(new Date(retried.nextAttemptAt)).toEqual(nextAttemptAt);

      await adapter.dead(pending.id, 4, "gave up");
      expect((await stored())[0]).toMatchObject({ status: "dead", attempts: 4, lastError: "gave up" });

      await adapter.complete(pending.id);
      expect((await stored())[0].status).toBe("delivered");
    });

    test("complete / retry / dead on a missing row are no-ops", async () => {
      const adapter = knexOutboxAdapter(db, { table: TABLE });

      await adapter.complete("obx_missing");
      await adapter.retry("obx_missing", 1, new Date(), "boom");
      await adapter.dead("obx_missing", 1, "boom");

      expect((await stored()).length).toBe(0);
    });

    test("custom table name is honored", async () => {
      const adapter = knexOutboxAdapter(db, { table: CUSTOM_TABLE });

      await adapter.insert([row()]);
      const claimed = await adapter.claim(10, new Date("2026-06-01"));

      expect(claimed.length).toBe(1);
      expect((await stored(CUSTOM_TABLE)).length).toBe(1);
      expect((await stored(TABLE)).length).toBe(0);
    });

    test("send() inside a transaction enqueues, worker tick delivers to a real server", async () => {
      const received: { body: string; eventId: string | null }[] = [];
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          received.push({ body: await request.text(), eventId: request.headers.get("webhook-id") });
          return new Response(null, { status: 200 });
        },
      });
      const wh = webhooks({
        events: { "user.created": z.object({ userId: z.string() }) },
        subscribers: [{ url: `http://localhost:${server.port}/hook` }],
        subject: "optional",
        signing: { secret: "s3cret" },
        delivery: outbox(knexOutboxAdapter(db, { table: TABLE })),
      });

      try {
        const sent = await db.transaction((trx) =>
          wh.with(trx).send({ event: "user.created", subject: "user_1", data: { userId: "u_1" } }),
        );
        expect(sent.ok).toBe(true);
        const [enqueued] = await stored();
        expect(enqueued).toMatchObject({ status: "pending", subject: "user_1" });

        const report = await wh.worker().tick();

        expect(report).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
        expect((await stored())[0].status).toBe("delivered");
        expect(received.length).toBe(1);
        expect(received[0]!.eventId).toBe(enqueued.eventId);
        expect(JSON.parse(received[0]!.body)).toMatchObject({ data: { userId: "u_1" } });
      } finally {
        server.stop(true);
      }
    });
  });
}

describe("knexOutboxAdapter options", () => {
  test("rejects table names that aren't plain identifiers", () => {
    const db = knex({ client: "pg" });
    expect(() => knexOutboxAdapter(db, { table: 'x"; DROP TABLE y;--' })).toThrow(
      "plain SQL identifier",
    );
  });
});
