import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { OutboxRow } from "@thallesp/webhooks";
import { DataSource, type EntitySchema } from "typeorm";
import { type OutboxDatabaseType, typeormOutboxAdapter, webhookOutboxSchema } from "../src/index";

// CI points every adapter's tests at one shared database per engine, so these
// tables are named for this package and are the only ones created or dropped.
const TABLE = "outbox_typeorm";
const CUSTOM_TABLE = "outbox_typeorm_custom";

// Same DDL as the README, so the test also proves the copy-paste SQL works.
const createTableSql: Record<OutboxDatabaseType, (table: string) => string[]> = {
  postgres: (table) => [
    `CREATE TABLE "${table}" (
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
    )`,
    `CREATE INDEX "${table}_status_nextAttemptAt_idx" ON "${table}" ("status", "nextAttemptAt")`,
  ],
  mysql: (table) => [
    `CREATE TABLE \`${table}\` (
      \`id\` varchar(255) NOT NULL PRIMARY KEY,
      \`eventId\` varchar(255) NOT NULL,
      \`eventType\` varchar(255) NOT NULL,
      \`subject\` varchar(255) NULL,
      \`body\` longtext NOT NULL,
      \`url\` text NOT NULL,
      \`secret\` text NULL,
      \`attempts\` int NOT NULL,
      \`nextAttemptAt\` datetime(3) NOT NULL,
      \`status\` varchar(255) NOT NULL,
      \`lastError\` text NULL,
      \`createdAt\` datetime(3) NOT NULL,
      INDEX \`${table}_status_nextAttemptAt_idx\` (\`status\`, \`nextAttemptAt\`)
    )`,
  ],
};

const dropTableSql: Record<OutboxDatabaseType, (table: string) => string> = {
  postgres: (table) => `DROP TABLE IF EXISTS "${table}"`,
  mysql: (table) => `DROP TABLE IF EXISTS \`${table}\``,
};

function dataSourceFor(type: OutboxDatabaseType, url: string) {
  const entities: EntitySchema<OutboxRow>[] = [
    webhookOutboxSchema({ type, table: TABLE }),
    webhookOutboxSchema({ type, table: CUSTOM_TABLE }),
  ];
  if (type === "mysql") return new DataSource({ type, url, entities, timezone: "Z" });
  return new DataSource({ type, url, entities });
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
    nextAttemptAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "pending",
    lastError: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const databases = [
  { type: "postgres", url: process.env.WEBHOOKS_TEST_POSTGRES_URL },
  { type: "mysql", url: process.env.WEBHOOKS_TEST_MYSQL_URL },
] as const;

for (const { type, url } of databases) {
  describe.skipIf(!url)(`typeormOutboxAdapter on ${type}`, () => {
    const dataSource = dataSourceFor(type, url ?? "");
    const adapter = typeormOutboxAdapter(dataSource, { table: TABLE });

    async function readRow(id: string, table = TABLE) {
      return dataSource.manager.findOneBy<OutboxRow>(table, { id });
    }

    beforeAll(async () => {
      await dataSource.initialize();
      for (const table of [TABLE, CUSTOM_TABLE]) {
        await dataSource.query(dropTableSql[type](table));
        for (const sql of createTableSql[type](table)) await dataSource.query(sql);
      }
    });

    afterAll(async () => {
      for (const table of [TABLE, CUSTOM_TABLE]) await dataSource.query(dropTableSql[type](table));
      await dataSource.destroy();
    });

    beforeEach(async () => {
      await dataSource.manager.clear(TABLE);
      await dataSource.manager.clear(CUSTOM_TABLE);
    });

    test("the README SQL matches the entity schema (no pending migration)", async () => {
      const pending = await dataSource.driver.createSchemaBuilder().log();
      expect(pending.upQueries.map((query) => query.query)).toEqual([]);
    });

    test("insert without tx writes through the data source", async () => {
      const pending = row({ subject: "user_1", secret: "whsec" });

      await adapter.insert([pending]);

      expect(await readRow(pending.id)).toEqual(pending);
    });

    test("insert inside a committed transaction is visible", async () => {
      const pending = row();

      await dataSource.transaction(async (manager) => {
        await adapter.insert([pending], manager);
      });

      expect(await readRow(pending.id)).not.toBeNull();
    });

    test("insert inside a rolled-back transaction leaves no row", async () => {
      const pending = row();

      const rolledBack = dataSource.transaction(async (manager) => {
        await adapter.insert([pending], manager);
        throw new Error("rollback");
      });

      expect(rolledBack).rejects.toThrow("rollback");
      await rolledBack.catch(() => {});
      expect(await readRow(pending.id)).toBeNull();
    });

    test("claim returns due pending rows ordered by nextAttemptAt, up to limit", async () => {
      const now = new Date("2026-06-01T00:00:00.000Z");
      const later = row({ nextAttemptAt: new Date("2026-03-01T00:00:00.000Z") });
      const earliest = row({ nextAttemptAt: new Date("2026-01-01T00:00:00.000Z") });
      const middle = row({ nextAttemptAt: new Date("2026-02-01T00:00:00.000Z") });
      const notDue = row({ nextAttemptAt: new Date("2026-07-01T00:00:00.000Z") });
      const delivered = row({ status: "delivered" });
      const dead = row({ status: "dead" });
      await adapter.insert([later, earliest, middle, notDue, delivered, dead]);

      const claimed = await adapter.claim(2, now);

      expect(claimed.map((claimedRow) => claimedRow.id)).toEqual([earliest.id, middle.id]);
      expect(claimed.every((claimedRow) => claimedRow.status === "pending")).toBe(true);
      expect((await adapter.claim(10, now)).map((claimedRow) => claimedRow.id)).toEqual([later.id]);
    });

    test("claimed rows stay pending and hidden until claimTimeoutMs passes", async () => {
      const shortClaims = typeormOutboxAdapter(dataSource, { table: TABLE, claimTimeoutMs: 5_000 });
      const pending = row();
      await shortClaims.insert([pending]);
      const now = new Date("2026-06-01T00:00:00.000Z");

      const [claimed] = await shortClaims.claim(10, now);

      expect(claimed?.nextAttemptAt).toEqual(new Date(now.getTime() + 5_000));
      expect(await readRow(pending.id)).toMatchObject({
        status: "pending",
        nextAttemptAt: new Date(now.getTime() + 5_000),
      });
      expect(await shortClaims.claim(10, new Date(now.getTime() + 4_999))).toEqual([]);
      expect(await shortClaims.claim(10, new Date(now.getTime() + 5_000))).toHaveLength(1);
    });

    test("dates come back as Date with millisecond precision", async () => {
      const createdAt = new Date("2026-01-02T03:04:05.678Z");
      await adapter.insert([row({ createdAt, nextAttemptAt: createdAt })]);

      const [claimed] = await adapter.claim(1, new Date("2026-06-01T00:00:00.000Z"));

      expect(claimed?.createdAt).toBeInstanceOf(Date);
      expect(claimed?.createdAt.toISOString()).toBe("2026-01-02T03:04:05.678Z");
      expect(claimed?.nextAttemptAt).toBeInstanceOf(Date);
    });

    test("concurrent claims on separate connections never return a row twice", async () => {
      const rowCount = 60;
      await adapter.insert(Array.from({ length: rowCount }, () => row()));
      const workers = Array.from({ length: 4 }, () => dataSourceFor(type, url ?? ""));
      await Promise.all(workers.map((worker) => worker.initialize()));
      const now = new Date("2026-06-01T00:00:00.000Z");

      async function drain(worker: DataSource) {
        const workerAdapter = typeormOutboxAdapter(worker, { table: TABLE });
        const ids: string[] = [];
        for (;;) {
          const claimed = await Promise.all([workerAdapter.claim(7, now), workerAdapter.claim(7, now)]);
          const claimedIds = claimed.flat().map((claimedRow) => claimedRow.id);
          if (claimedIds.length === 0) return ids;
          ids.push(...claimedIds);
        }
      }

      try {
        const perWorker = await Promise.all(workers.map((worker) => drain(worker)));
        const leftovers = await adapter.claim(rowCount, now);
        const ids = [...perWorker.flat(), ...leftovers.map((claimedRow) => claimedRow.id)];

        expect(ids).toHaveLength(rowCount);
        expect(new Set(ids).size).toBe(rowCount);
        expect(perWorker.filter((workerIds) => workerIds.length > 0).length).toBeGreaterThan(1);
      } finally {
        await Promise.all(workers.map((worker) => worker.destroy()));
      }
    });

    test("complete / retry / dead update the row", async () => {
      const pending = row();
      await adapter.insert([pending]);

      const nextAttemptAt = new Date("2026-02-01T00:00:00.000Z");
      await adapter.retry(pending.id, 3, nextAttemptAt, "boom");
      expect(await readRow(pending.id)).toMatchObject({ attempts: 3, nextAttemptAt, lastError: "boom" });

      await adapter.dead(pending.id, 4, "gave up");
      expect(await readRow(pending.id)).toMatchObject({ status: "dead", attempts: 4, lastError: "gave up" });

      await adapter.complete(pending.id);
      expect((await readRow(pending.id))?.status).toBe("delivered");
    });

    test("complete / retry / dead on a missing row are no-ops", async () => {
      await adapter.complete("obx_missing");
      await adapter.retry("obx_missing", 1, new Date(), "boom");
      await adapter.dead("obx_missing", 1, "gave up");

      expect(await dataSource.manager.count(TABLE)).toBe(0);
    });

    test("custom table name is honored", async () => {
      const custom = typeormOutboxAdapter(dataSource, { table: CUSTOM_TABLE });
      const pending = row();

      await custom.insert([pending]);

      expect(await readRow(pending.id, CUSTOM_TABLE)).not.toBeNull();
      expect(await readRow(pending.id)).toBeNull();
      expect(await custom.claim(10, new Date("2026-06-01T00:00:00.000Z"))).toHaveLength(1);
    });

    test("send() inside a transaction enqueues, worker tick delivers", async () => {
      const { webhooks, outbox } = await import("@thallesp/webhooks");
      const { z } = await import("zod");
      const received: string[] = [];
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          received.push(await request.text());
          return new Response(null, { status: 200 });
        },
      });

      try {
        const wh = webhooks({
          events: { "user.created": z.object({ userId: z.string() }) },
          subscribers: [{ url: `http://127.0.0.1:${server.port}/hook` }],
          subject: "optional",
          signing: { secret: "s3cret" },
          delivery: outbox(adapter),
        });

        await dataSource.transaction(async (manager) => {
          const sent = await wh.with(manager).send({ event: "user.created", data: { userId: "u_1" } });
          expect(sent.ok).toBe(true);
        });
        // @ts-expect-error with() only takes a TypeORM EntityManager
        const typeCheckOnly = () => wh.with({});
        expect(typeCheckOnly).toBeFunction();

        const report = await wh.worker().tick();

        expect(report).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
        expect(received).toHaveLength(1);
        expect(JSON.parse(received[0] ?? "")).toMatchObject({ data: { userId: "u_1" } });
        const [stored] = await dataSource.manager.find<OutboxRow>(TABLE);
        expect(stored?.status).toBe("delivered");
      } finally {
        await server.stop(true);
      }
    });
  });
}

describe("option validation", () => {
  test("rejects table names that aren't plain identifiers", () => {
    expect(() => webhookOutboxSchema({ type: "postgres", table: 'x"; DROP TABLE y;--' })).toThrow(
      "plain SQL identifier",
    );
    const dataSource = new DataSource({ type: "postgres" });
    expect(() => typeormOutboxAdapter(dataSource, { table: "x; y" })).toThrow("plain SQL identifier");
  });

  test("rejects databases without SKIP LOCKED", () => {
    // @ts-expect-error only postgres and mysql are supported
    expect(() => webhookOutboxSchema({ type: "sqlite" })).toThrow('"sqlite" is not supported');
    const dataSource = new DataSource({ type: "mariadb" });
    expect(() => typeormOutboxAdapter(dataSource)).toThrow('"mariadb" is not supported');
  });
});
