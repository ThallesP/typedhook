import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { outbox, webhooks, type OutboxRow } from "@typedhook/sdk";
import { Sequelize, type Dialect } from "sequelize";
import { z } from "zod";
import { sequelizeOutboxAdapter } from "../src/index";

// CI shares one database per engine across every adapter package, so only
// touch tables with this package's prefix.
const TABLE = "outbox_sequelize";
const CUSTOM_TABLE = "outbox_sequelize_custom";
const SYNCED_TABLE = "outbox_sequelize_synced";

const suites: { dialect: Dialect; url: string | undefined }[] = [
  { dialect: "postgres", url: process.env.TYPEDHOOK_TEST_POSTGRES_URL },
  { dialect: "mysql", url: process.env.TYPEDHOOK_TEST_MYSQL_URL },
  { dialect: "sqlite", url: ":memory:" },
];

function connect(dialect: Dialect, url: string): Sequelize {
  if (dialect === "sqlite") return new Sequelize({ dialect, storage: url, logging: false });
  return new Sequelize(url, { logging: false, pool: { max: 10 } });
}

// Same DDL as the README.
function createTableSql(dialect: Dialect, table: string): string[] {
  if (dialect === "mysql") {
    return [
      `CREATE TABLE \`${table}\` (
        \`id\`            VARCHAR(255) NOT NULL PRIMARY KEY,
        \`eventId\`       VARCHAR(255) NOT NULL,
        \`eventType\`     VARCHAR(255) NOT NULL,
        \`subject\`       VARCHAR(255),
        \`body\`          LONGTEXT NOT NULL,
        \`url\`           TEXT NOT NULL,
        \`secret\`        VARCHAR(255),
        \`attempts\`      INT NOT NULL,
        \`nextAttemptAt\` DATETIME(3) NOT NULL,
        \`status\`        VARCHAR(255) NOT NULL,
        \`lastError\`     TEXT,
        \`createdAt\`     DATETIME(3) NOT NULL,
        INDEX \`${table}_status_next_attempt_at\` (\`status\`, \`nextAttemptAt\`)
      )`,
    ];
  }
  const timestamp = dialect === "postgres" ? "TIMESTAMPTZ(3)" : "DATETIME";
  return [
    `CREATE TABLE "${table}" (
      "id"            VARCHAR(255) PRIMARY KEY,
      "eventId"       VARCHAR(255) NOT NULL,
      "eventType"     VARCHAR(255) NOT NULL,
      "subject"       VARCHAR(255),
      "body"          TEXT NOT NULL,
      "url"           TEXT NOT NULL,
      "secret"        VARCHAR(255),
      "attempts"      INTEGER NOT NULL,
      "nextAttemptAt" ${timestamp} NOT NULL,
      "status"        VARCHAR(255) NOT NULL,
      "lastError"     TEXT,
      "createdAt"     ${timestamp} NOT NULL
    )`,
    `CREATE INDEX "${table}_status_next_attempt_at" ON "${table}" ("status", "nextAttemptAt")`,
  ];
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
    nextAttemptAt: new Date(0),
    status: "pending",
    lastError: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

for (const { dialect, url } of suites) {
  describe.skipIf(!url)(`sequelizeOutboxAdapter (${dialect})`, () => {
    let sequelize: Sequelize;

    async function rowsIn(table: string): Promise<Record<string, unknown>[]> {
      const rows = await sequelize.getQueryInterface().select(null, table, {});
      return rows.map((found) => ({ ...found }));
    }

    async function dropOwnTables(): Promise<void> {
      for (const table of [TABLE, CUSTOM_TABLE, SYNCED_TABLE]) {
        await sequelize.getQueryInterface().dropTable(table);
      }
    }

    beforeAll(async () => {
      sequelize = connect(dialect, url ?? "");
      await dropOwnTables();
      for (const table of [TABLE, CUSTOM_TABLE]) {
        for (const sql of createTableSql(dialect, table)) await sequelize.query(sql);
      }
    });

    afterAll(async () => {
      await dropOwnTables();
      await sequelize.close();
    });

    beforeEach(async () => {
      await sequelize.getQueryInterface().bulkDelete(TABLE, {});
      await sequelize.getQueryInterface().bulkDelete(CUSTOM_TABLE, {});
    });

    test("insert without tx writes through the base connection", async () => {
      const adapter = sequelizeOutboxAdapter(sequelize, { table: TABLE });

      await adapter.insert([row(), row()]);

      expect((await rowsIn(TABLE)).length).toBe(2);
    });

    test("insert inside a committed transaction persists", async () => {
      const adapter = sequelizeOutboxAdapter(sequelize, { table: TABLE });
      const pending = row();

      await sequelize.transaction(async (tx) => {
        await adapter.insert([pending], tx);
      });

      const rows = await rowsIn(TABLE);
      expect(rows.map((found) => found.id)).toEqual([pending.id]);
    });

    test("insert inside a rolled-back transaction leaves no row", async () => {
      const adapter = sequelizeOutboxAdapter(sequelize, { table: TABLE });

      const rolledBack = sequelize.transaction(async (tx) => {
        await adapter.insert([row()], tx);
        throw new Error("rollback");
      });

      expect(rolledBack).rejects.toThrow("rollback");
      await rolledBack.catch(() => undefined);
      expect((await rowsIn(TABLE)).length).toBe(0);
    });

    test("claim returns due pending rows oldest first, up to limit", async () => {
      const adapter = sequelizeOutboxAdapter(sequelize, { table: TABLE });
      const oldest = row({ nextAttemptAt: new Date("2026-01-01T00:00:00Z") });
      const middle = row({ nextAttemptAt: new Date("2026-01-02T00:00:00Z") });
      const newest = row({ nextAttemptAt: new Date("2026-01-03T00:00:00Z") });
      await adapter.insert([
        newest,
        row({ nextAttemptAt: new Date("2999-01-01T00:00:00Z") }),
        row({ status: "delivered" }),
        row({ status: "dead" }),
        oldest,
        middle,
      ]);

      const claimed = await adapter.claim(2, new Date("2026-06-01T00:00:00Z"));

      // UPDATE ... RETURNING doesn't keep the subquery's order, so compare
      // the picked set; the worker delivers a batch concurrently anyway.
      expect(claimed.map((found) => found.id).sort()).toEqual([oldest.id, middle.id].sort());
      expect(claimed.every((found) => found.status === "pending")).toBe(true);
      expect((await adapter.claim(10, new Date("2026-06-01T00:00:00Z"))).map((found) => found.id)).toEqual([
        newest.id,
      ]);
    });

    test("claim compares nextAttemptAt to the millisecond", async () => {
      const adapter = sequelizeOutboxAdapter(sequelize, { table: TABLE });
      await adapter.insert([row({ nextAttemptAt: new Date("2026-06-01T00:00:00.500Z") })]);

      expect((await adapter.claim(10, new Date("2026-06-01T00:00:00.499Z"))).length).toBe(0);
      expect((await adapter.claim(10, new Date("2026-06-01T00:00:00.500Z"))).length).toBe(1);
    });

    test("claimed rows stay hidden until claimTimeoutMs passes", async () => {
      const adapter = sequelizeOutboxAdapter(sequelize, { table: TABLE, claimTimeoutMs: 60_000 });
      await adapter.insert([row()]);
      const now = new Date("2026-06-01T00:00:00Z");

      expect((await adapter.claim(10, now)).length).toBe(1);
      expect((await adapter.claim(10, now)).length).toBe(0);
      expect((await adapter.claim(10, new Date(now.getTime() + 59_000))).length).toBe(0);
      expect((await adapter.claim(10, new Date(now.getTime() + 61_000))).length).toBe(1);
    });

    test("claim returns every column, with dates as Date", async () => {
      const adapter = sequelizeOutboxAdapter(sequelize, { table: TABLE, claimTimeoutMs: 5_000 });
      const pending = row({
        subject: "user_1",
        secret: "whsec_x",
        body: '{"userId":"u_1"}',
        attempts: 2,
        lastError: "HTTP 500",
        createdAt: new Date("2026-01-01T12:34:56.789Z"),
      });
      await adapter.insert([pending]);
      const now = new Date("2026-06-01T00:00:00.123Z");

      const [claimed] = await adapter.claim(1, now);

      expect(claimed).toEqual({ ...pending, nextAttemptAt: new Date(now.getTime() + 5_000) });
      expect(claimed!.createdAt).toBeInstanceOf(Date);
      expect(claimed!.nextAttemptAt).toBeInstanceOf(Date);
    });

    test("parallel claims on separate connections never return a row twice", async () => {
      const adapter = sequelizeOutboxAdapter(sequelize, { table: TABLE });
      const rows = Array.from({ length: 200 }, (_, index) => row({ nextAttemptAt: new Date(index * 1_000) }));
      await adapter.insert(rows);
      const now = new Date("2026-06-01T00:00:00Z");

      // Rounds of 8 simultaneous claims, so every round really overlaps
      // instead of one warm connection draining the table alone.
      const ids: string[] = [];
      let busiestRoundWorkers = 0;
      for (;;) {
        const round = await Promise.all(Array.from({ length: 8 }, () => adapter.claim(7, now)));
        const nonEmpty = round.filter((claimed) => claimed.length > 0);
        if (nonEmpty.length === 0) break;
        busiestRoundWorkers = Math.max(busiestRoundWorkers, nonEmpty.length);
        ids.push(...round.flat().map((found) => found.id));
      }

      expect(ids.length).toBe(200);
      expect(new Set(ids).size).toBe(200);
      expect(busiestRoundWorkers).toBeGreaterThan(1);
    });

    test("complete / retry / dead update the row; a missing row is a no-op", async () => {
      const adapter = sequelizeOutboxAdapter(sequelize, { table: TABLE });
      const pending = row();
      await adapter.insert([pending]);

      const nextAttemptAt = new Date("2026-02-01T00:00:00Z");
      await adapter.retry(pending.id, 3, nextAttemptAt, "boom");
      let [stored] = await rowsIn(TABLE);
      expect(stored).toMatchObject({ status: "pending", attempts: 3, lastError: "boom" });
      expect(new Date(String(stored!.nextAttemptAt)).getTime()).toBe(nextAttemptAt.getTime());

      await adapter.dead(pending.id, 4, "gave up");
      [stored] = await rowsIn(TABLE);
      expect(stored).toMatchObject({ status: "dead", attempts: 4, lastError: "gave up" });

      await adapter.complete(pending.id);
      [stored] = await rowsIn(TABLE);
      expect(stored!.status).toBe("delivered");

      await adapter.complete("obx_missing");
      await adapter.retry("obx_missing", 1, nextAttemptAt, "x");
      await adapter.dead("obx_missing", 1, "x");
      expect((await rowsIn(TABLE)).length).toBe(1);
    });

    test("custom table name is honored", async () => {
      const adapter = sequelizeOutboxAdapter(sequelize, { table: CUSTOM_TABLE });

      await adapter.insert([row()]);
      const claimed = await adapter.claim(10, new Date());

      expect(claimed.length).toBe(1);
      expect((await rowsIn(CUSTOM_TABLE)).length).toBe(1);
      expect((await rowsIn(TABLE)).length).toBe(0);
    });

    test("sequelize.sync() can create the table from the adapter's model", async () => {
      const synced = connect(dialect, url ?? "");
      const adapter = sequelizeOutboxAdapter(synced, { table: SYNCED_TABLE });
      await synced.sync();

      await adapter.insert([row()]);
      expect((await adapter.claim(10, new Date())).length).toBe(1);
      await synced.close();
    });

    test("rejects table names that aren't plain identifiers", () => {
      expect(() => sequelizeOutboxAdapter(sequelize, { table: 'x"; DROP TABLE y;--' })).toThrow(
        "plain SQL identifier",
      );
    });

    test("end-to-end: with(tx).send() enqueues, worker tick delivers", async () => {
      const received: { body: string; signature: string | null }[] = [];
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          received.push({ body: await request.text(), signature: request.headers.get("webhook-signature") });
          return new Response(null, { status: 200 });
        },
      });
      const wh = webhooks({
        events: { "user.created": z.object({ userId: z.string() }) },
        subscribers: [{ url: `http://127.0.0.1:${server.port}/hook` }],
        signing: { secret: "s3cret" },
        delivery: outbox(sequelizeOutboxAdapter(sequelize, { table: TABLE })),
      });

      try {
        await sequelize.transaction(async (tx) => {
          const sent = await wh.with(tx).send({
            event: "user.created",
            subject: "u_1",
            data: { userId: "u_1" },
          });
          expect(sent.ok).toBe(true);
        });
        const report = await wh.worker().tick();

        expect(report).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
        expect(received.length).toBe(1);
        expect(JSON.parse(received[0]!.body)).toMatchObject({ event: "user.created", subject: "u_1", data: { userId: "u_1" } });
        expect(received[0]!.signature).not.toBeNull();
        const [stored] = await rowsIn(TABLE);
        expect(stored!.status).toBe("delivered");
      } finally {
        await server.stop(true);
      }
    });
  });
}

describe("sequelizeOutboxAdapter dialect check", () => {
  test("rejects dialects without a tested claim strategy", () => {
    const mssql = { getDialect: () => "mssql" } as unknown as Sequelize;
    expect(() => sequelizeOutboxAdapter(mssql)).toThrow('unsupported dialect "mssql"');
  });
});
