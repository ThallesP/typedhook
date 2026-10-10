import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { EntityManager, EntitySchema, MikroORM } from "@mikro-orm/core";
import { MikroORM as LibSqlORM } from "@mikro-orm/libsql";
import { MikroORM as MySqlORM } from "@mikro-orm/mysql";
import { MikroORM as PostgresORM } from "@mikro-orm/postgresql";
import type { OutboxRow } from "@thallesp/webhooks";
import { WebhookOutbox, mikroOrmOutboxAdapter, webhookOutboxSchema } from "../src/index";

const postgresUrl = process.env.WEBHOOKS_TEST_POSTGRES_URL;
const mysqlUrl = process.env.WEBHOOKS_TEST_MYSQL_URL;

// CI shares one database per engine across every adapter package, so the
// server suites use a table only this package touches.
const TABLE = "outbox_mikro_orm";

interface Dialect {
  name: string;
  skip: boolean;
  entity: EntitySchema<OutboxRow>;
  /** Whether claim must emit SKIP LOCKED (SQLite has no row locks). */
  skipLocked: boolean;
  /** Separate pooled connections; SQLite runs everything on one. */
  separateConnections: boolean;
  init: (entity: EntitySchema<OutboxRow>, logger: (message: string) => void) => Promise<MikroORM>;
}

const dialects: Dialect[] = [
  {
    name: "postgres",
    skip: !postgresUrl,
    entity: webhookOutboxSchema({ tableName: TABLE }),
    skipLocked: true,
    separateConnections: true,
    init: (entity, logger) =>
      PostgresORM.init({ clientUrl: postgresUrl, entities: [entity], debug: ["query"], logger }),
  },
  {
    name: "mysql",
    skip: !mysqlUrl,
    entity: webhookOutboxSchema({ tableName: TABLE }),
    skipLocked: true,
    separateConnections: true,
    init: (entity, logger) =>
      MySqlORM.init({ clientUrl: mysqlUrl, entities: [entity], debug: ["query"], logger }),
  },
  {
    name: "sqlite (libsql, in-memory)",
    skip: false,
    entity: WebhookOutbox,
    skipLocked: false,
    separateConnections: false,
    init: (entity, logger) =>
      LibSqlORM.init({ dbName: ":memory:", entities: [entity], debug: ["query"], logger }),
  },
];

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
    createdAt: new Date("2026-01-01T00:00:00.123Z"),
    ...overrides,
  };
}

for (const dialect of dialects) {
  describe.skipIf(dialect.skip)(`mikroOrmOutboxAdapter on ${dialect.name}`, () => {
    const { entity } = dialect;
    const queries: string[] = [];
    let orm: MikroORM;

    async function find(id: string) {
      return orm.em.fork().findOne(entity, { id }, { disableIdentityMap: true });
    }

    // Plain DROP of our own table only: the schema generator's drop()
    // introspects the whole database, which is shared in CI.
    async function dropTable() {
      const table = orm.em.getPlatform().quoteIdentifier(entity.meta.tableName);
      await orm.em.getConnection().execute(`drop table if exists ${table}`);
    }

    beforeAll(async () => {
      orm = await dialect.init(entity, (message) => queries.push(message));
      await dropTable();
      await orm.schema.execute(await orm.schema.getCreateSchemaSQL({ wrap: false }));
    });

    afterAll(async () => {
      await dropTable();
      await orm.close();
    });

    beforeEach(async () => {
      await orm.em.fork().nativeDelete(entity, {});
      queries.length = 0;
    });

    test("insert without tx writes through a fork of the base em", async () => {
      const adapter = mikroOrmOutboxAdapter(orm.em, { entity });
      const pending = row({ subject: "user_1", secret: "s3cret" });

      await adapter.insert([pending]);

      expect(await find(pending.id)).toMatchObject(pending);
    });

    test("insert inside a committed tx runs on the tx right away", async () => {
      const adapter = mikroOrmOutboxAdapter(orm.em, { entity });
      const pending = row();

      await orm.em.transactional(async (em) => {
        await adapter.insert([pending], em);
        // Already in the database on the tx connection, no flush needed.
        expect(await em.count(entity, { id: pending.id })).toBe(1);
        if (dialect.separateConnections) {
          expect(await find(pending.id)).toBeNull();
        }
      });

      expect(await find(pending.id)).not.toBeNull();
    });

    test("insert inside a rolled back tx leaves no row", async () => {
      const adapter = mikroOrmOutboxAdapter(orm.em, { entity });
      const pending = row();

      const failing = orm.em.transactional(async (em) => {
        await adapter.insert([pending], em);
        throw new Error("rollback");
      });

      await expect(failing).rejects.toThrow("rollback");
      expect(await find(pending.id)).toBeNull();
    });

    test("claim returns due pending rows oldest first, respects limit, and hides them until the timeout", async () => {
      const adapter = mikroOrmOutboxAdapter(orm.em, { entity, claimTimeoutMs: 60_000 });
      const now = new Date("2026-06-01T12:00:00.000Z");
      const older = row({ nextAttemptAt: new Date("2026-06-01T11:00:00.000Z") });
      const newer = row({ nextAttemptAt: new Date("2026-06-01T11:30:00.000Z") });
      const oldest = row({ nextAttemptAt: new Date("2026-06-01T10:00:00.000Z") });
      const future = row({ nextAttemptAt: new Date("2026-06-01T13:00:00.000Z") });
      const delivered = row({ status: "delivered" });
      const dead = row({ status: "dead" });
      await adapter.insert([older, newer, oldest, future, delivered, dead]);

      const first = await adapter.claim(2, now);

      expect(first.map((claimed) => claimed.id)).toEqual([oldest.id, older.id]);
      expect(first.every((claimed) => claimed.status === "pending")).toBe(true);
      if (dialect.skipLocked) {
        expect(queries.some((query) => /for update skip locked/i.test(query))).toBe(true);
      }

      const second = await adapter.claim(10, now);
      expect(second.map((claimed) => claimed.id)).toEqual([newer.id]);
      expect(await adapter.claim(10, now)).toEqual([]);

      const afterTimeout = await adapter.claim(10, new Date(now.getTime() + 60_001));
      expect(afterTimeout.map((claimed) => claimed.id).sort()).toEqual(
        [oldest.id, older.id, newer.id].sort(),
      );
    });

    test("claim returns Dates and pushes nextAttemptAt to the claim horizon", async () => {
      const adapter = mikroOrmOutboxAdapter(orm.em, { entity, claimTimeoutMs: 5_000 });
      const pending = row();
      await adapter.insert([pending]);
      const now = new Date("2026-06-01T12:00:00.000Z");

      const [claimed] = await adapter.claim(1, now);

      expect(claimed!.createdAt).toBeInstanceOf(Date);
      expect(claimed!.createdAt.getTime()).toBe(pending.createdAt.getTime());
      expect(claimed!.nextAttemptAt).toBeInstanceOf(Date);
      expect(claimed!.nextAttemptAt.getTime()).toBe(now.getTime() + 5_000);
      expect((await find(pending.id))!.nextAttemptAt.getTime()).toBe(now.getTime() + 5_000);
    });

    test("body over 64 KB round-trips (MySQL TEXT would truncate or reject it)", async () => {
      const adapter = mikroOrmOutboxAdapter(orm.em, { entity });
      const body = JSON.stringify({ blob: "x".repeat(100 * 1024) });
      const pending = row({ body });
      await adapter.insert([pending]);

      const [claimed] = await adapter.claim(1, new Date());

      expect(claimed!.body.length).toBe(body.length);
      expect(claimed!.body).toBe(body);
    });

    test("parallel claims never return the same row twice", async () => {
      const adapter = mikroOrmOutboxAdapter(orm.em, { entity });
      const rows = Array.from({ length: 200 }, (_, index) =>
        row({ nextAttemptAt: new Date(index * 1_000) }),
      );
      await adapter.insert(rows);
      const now = new Date();

      async function drain() {
        const ids: string[] = [];
        while (true) {
          const claimed = await adapter.claim(7, now);
          if (claimed.length === 0) return ids;
          ids.push(...claimed.map((claimedRow) => claimedRow.id));
        }
      }
      const workers = await Promise.all(Array.from({ length: 8 }, drain));
      const ids = workers.flat();

      expect(ids.length).toBe(rows.length);
      expect(new Set(ids).size).toBe(rows.length);
    });

    test("complete / retry / dead update the row; a missing row is a no-op", async () => {
      const adapter = mikroOrmOutboxAdapter(orm.em, { entity });
      const pending = row();
      await adapter.insert([pending]);

      const nextAttemptAt = new Date("2026-02-01T00:00:00.456Z");
      await adapter.retry(pending.id, 3, nextAttemptAt, "boom");
      expect(await find(pending.id)).toMatchObject({
        attempts: 3,
        nextAttemptAt,
        lastError: "boom",
        status: "pending",
      });

      await adapter.dead(pending.id, 4, "gave up");
      expect(await find(pending.id)).toMatchObject({
        status: "dead",
        attempts: 4,
        lastError: "gave up",
      });

      await adapter.complete(pending.id);
      expect((await find(pending.id))!.status).toBe("delivered");

      await adapter.complete("obx_missing");
      await adapter.retry("obx_missing", 1, new Date(), "x");
      await adapter.dead("obx_missing", 1, "x");
    });

    test("end-to-end: with(em).send() inside transactional, worker tick delivers", async () => {
      const { webhooks, outbox } = await import("@thallesp/webhooks");
      const { z } = await import("zod");
      const received: string[] = [];
      using server = Bun.serve({
        port: 0,
        async fetch(request) {
          received.push(await request.text());
          return new Response(null, { status: 200 });
        },
      });
      const adapter = mikroOrmOutboxAdapter<EntityManager>(orm.em, { entity });

      const wh = webhooks({
        events: { "user.created": z.object({ userId: z.string() }) },
        subscribers: [{ url: server.url.href }],
        signing: { secret: "s3cret" },
        delivery: outbox(adapter),
      });

      await orm.em.transactional(async (em) => {
        const sent = await wh.with(em).send({
          event: "user.created",
          subject: "u_1",
          data: { userId: "u_1" },
        });
        expect(sent.ok).toBe(true);
      });

      const report = await wh.worker().tick();

      expect(report).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
      expect(JSON.parse(received[0]!)).toMatchObject({
        event: "user.created",
        subject: "u_1",
        data: { userId: "u_1" },
      });
      const stored = await orm.em.fork().find(entity, {}, { disableIdentityMap: true });
      expect(stored.map((storedRow) => storedRow.status)).toEqual(["delivered"]);
    });
  });
}

describe("webhookOutboxSchema", () => {
  test("defaults to the webhook_outbox table", () => {
    expect(WebhookOutbox.meta.tableName).toBe("webhook_outbox");
  });

  test("rejects table names that aren't plain identifiers", () => {
    expect(() => webhookOutboxSchema({ tableName: 'x"; DROP TABLE y;--' })).toThrow(
      "plain SQL identifier",
    );
  });
});
