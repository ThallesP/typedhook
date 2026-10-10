import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { OutboxRow } from "@thallesp/webhooks";
import { type Db, MongoClient } from "mongodb";
import { type OutboxDocument, mongodbOutboxAdapter } from "../src/index";

const url = process.env.WEBHOOKS_TEST_MONGO_URL ?? "";
const DATABASE = "wh_mongodb";
// Collection names unique to this package: CI shares one Mongo across packages.
const COLLECTION = "outbox_mongodb";
const CUSTOM_COLLECTION = "outbox_mongodb_custom";

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
    nextAttemptAt: new Date(0),
    status: "pending",
    lastError: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

describe.skipIf(!url)("mongodbOutboxAdapter", () => {
  let client: MongoClient;
  let db: Db;

  function outbox() {
    return db.collection<OutboxDocument>(COLLECTION);
  }

  beforeAll(async () => {
    client = await MongoClient.connect(url);
    db = client.db(DATABASE);
    await outbox().createIndex({ status: 1, nextAttemptAt: 1 });
  });

  beforeEach(async () => {
    await outbox().deleteMany({});
  });

  afterAll(async () => {
    await db.dropCollection(COLLECTION).catch(() => {});
    await db.dropCollection(CUSTOM_COLLECTION).catch(() => {});
    await client.close();
  });

  test("insert without tx writes through the db, id stored as _id", async () => {
    const adapter = mongodbOutboxAdapter(db, { collection: COLLECTION });
    const pending = row();

    await adapter.insert([pending]);

    const stored = await outbox().findOne({ _id: pending.id });
    expect(stored).not.toBeNull();
    expect(stored).not.toHaveProperty("id");
  });

  test("insert inside a committed transaction persists the row", async () => {
    const adapter = mongodbOutboxAdapter(db, { collection: COLLECTION });
    const pending = row();

    await client.withSession((session) =>
      session.withTransaction(() => adapter.insert([pending], session)),
    );

    expect(await outbox().countDocuments({ _id: pending.id })).toBe(1);
  });

  test("insert inside a rolled-back transaction leaves no row", async () => {
    const adapter = mongodbOutboxAdapter(db, { collection: COLLECTION });
    const pending = row();

    const transaction = client.withSession((session) =>
      session.withTransaction(async () => {
        await adapter.insert([pending], session);
        throw new Error("rollback");
      }),
    );

    expect(transaction).rejects.toThrow("rollback");
    await transaction.catch(() => {});
    expect(await outbox().countDocuments({ _id: pending.id })).toBe(0);
  });

  test("claim returns due pending rows in nextAttemptAt order, respects limit, hides claimed rows", async () => {
    const adapter = mongodbOutboxAdapter(db, { collection: COLLECTION, claimTimeoutMs: 60_000 });
    const now = new Date();
    const later = row({ nextAttemptAt: new Date(now.getTime() - 1_000) });
    const earlier = row({ nextAttemptAt: new Date(now.getTime() - 5_000) });
    await adapter.insert([
      later,
      earlier,
      row({ nextAttemptAt: new Date("2999-01-01") }),
      row({ status: "delivered" }),
      row({ status: "dead" }),
    ]);

    const first = await adapter.claim(1, now);
    const rest = await adapter.claim(10, now);

    expect(first.map((claimed) => claimed.id)).toEqual([earlier.id]);
    expect(rest.map((claimed) => claimed.id)).toEqual([later.id]);
    expect(rest[0]!.status).toBe("pending");
    expect(await adapter.claim(10, now)).toEqual([]);
    const afterTimeout = await adapter.claim(10, new Date(now.getTime() + 61_000));
    expect(afterTimeout.map((claimed) => claimed.id).sort()).toEqual(
      [earlier.id, later.id].sort(),
    );
  });

  test("claimed rows come back with Date fields", async () => {
    const adapter = mongodbOutboxAdapter(db, { collection: COLLECTION });
    await adapter.insert([row({ createdAt: new Date("2026-01-01T00:00:00Z") })]);

    const [claimed] = await adapter.claim(1, new Date());

    expect(claimed!.nextAttemptAt).toBeInstanceOf(Date);
    expect(claimed!.createdAt).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  test("concurrent claims on separate connections never return a row twice", async () => {
    const totalRows = 300;
    const adapter = mongodbOutboxAdapter(db, { collection: COLLECTION });
    await adapter.insert(
      Array.from({ length: totalRows }, (_, index) => row({ nextAttemptAt: new Date(index) })),
    );
    const workers = await Promise.all(
      Array.from({ length: 6 }, () => MongoClient.connect(url)),
    );

    try {
      const now = new Date();
      const claimedIds = await Promise.all(
        workers.map(async (worker) => {
          const workerAdapter = mongodbOutboxAdapter(worker.db(DATABASE), { collection: COLLECTION });
          const ids: string[] = [];
          for (;;) {
            const claimed = await workerAdapter.claim(7, now);
            if (claimed.length === 0) return ids;
            ids.push(...claimed.map((claimedRow) => claimedRow.id));
          }
        }),
      );

      const allIds = claimedIds.flat();
      expect(allIds.length).toBe(totalRows);
      expect(new Set(allIds).size).toBe(totalRows);
      expect(claimedIds.filter((ids) => ids.length > 0).length).toBeGreaterThan(1);
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
  });

  test("complete / retry / dead update the row by id; a missing row is a no-op", async () => {
    const adapter = mongodbOutboxAdapter(db, { collection: COLLECTION });
    const pending = row();
    await adapter.insert([pending]);

    const nextAttemptAt = new Date("2026-02-01");
    await adapter.retry(pending.id, 3, nextAttemptAt, "boom");
    expect(await outbox().findOne({ _id: pending.id })).toMatchObject({
      attempts: 3,
      nextAttemptAt,
      lastError: "boom",
    });

    await adapter.dead(pending.id, 4, "gave up");
    expect(await outbox().findOne({ _id: pending.id })).toMatchObject({
      status: "dead",
      attempts: 4,
      lastError: "gave up",
    });

    await adapter.complete(pending.id);
    expect((await outbox().findOne({ _id: pending.id }))!.status).toBe("delivered");

    await adapter.complete("obx_missing");
    await adapter.retry("obx_missing", 1, new Date(), "x");
    await adapter.dead("obx_missing", 1, "x");
    expect(await outbox().countDocuments({ _id: "obx_missing" })).toBe(0);
  });

  test("custom collection name is honored", async () => {
    const adapter = mongodbOutboxAdapter(db, { collection: CUSTOM_COLLECTION });
    const pending = row();

    await adapter.insert([pending]);
    const claimed = await adapter.claim(10, new Date());

    expect(claimed.map((claimedRow) => claimedRow.id)).toEqual([pending.id]);
    expect(await outbox().countDocuments({ _id: pending.id })).toBe(0);
  });

  test("rejects invalid collection names", () => {
    expect(() => mongodbOutboxAdapter(db, { collection: "" })).toThrow("invalid collection name");
    expect(() => mongodbOutboxAdapter(db, { collection: "a$b" })).toThrow("invalid collection name");
    expect(() => mongodbOutboxAdapter(db, { collection: "system.outbox" })).toThrow(
      "invalid collection name",
    );
  });

  test("end-to-end: with(session).send in a transaction, worker tick delivers", async () => {
    const { webhooks, outbox: outboxDelivery } = await import("@thallesp/webhooks");
    const { z } = await import("zod");
    const received: { body: string; signature: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push({
          body: await request.text(),
          signature: request.headers.get("webhook-signature"),
        });
        return new Response(null, { status: 200 });
      },
    });

    try {
      const wh = webhooks({
        events: { "user.created": z.object({ userId: z.string() }) },
        subscribers: [{ url: `http://127.0.0.1:${server.port}/hook` }],
        signing: { secret: "s3cret" },
        delivery: outboxDelivery(mongodbOutboxAdapter(db, { collection: COLLECTION })),
      });

      await client.withSession((session) =>
        session.withTransaction(async () => {
          const sent = await wh.with(session).send({
            event: "user.created",
            subject: "u_1",
            data: { userId: "u_1" },
          });
          expect(sent.ok).toBe(true);
        }),
      );
      expect(await outbox().countDocuments({ status: "pending" })).toBe(1);

      const report = await wh.worker().tick();

      expect(report).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
      expect(received.length).toBe(1);
      expect(received[0]!.signature).toStartWith("v1,");
      expect(JSON.parse(received[0]!.body)).toMatchObject({
        event: "user.created",
        subject: "u_1",
        data: { userId: "u_1" },
      });
      expect(await outbox().countDocuments({ status: "delivered" })).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
