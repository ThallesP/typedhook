import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CamelCasePlugin, Kysely, MysqlDialect, PostgresDialect, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { createPool } from "mysql2";
import { Pool } from "pg";
import { z } from "zod";
import { outbox, webhooks, type OutboxRow } from "@typedhook/sdk";
import {
  kyselyOutboxAdapter,
  type KyselyAdapterOptions,
  type WebhookOutboxDatabase,
} from "../src/index";

// Unique to this package: CI runs every adapter's tests against one shared
// database per engine.
const TABLE = "outbox_kysely";
const CUSTOM_TABLE = "outbox_kysely_custom";

interface UserTable {
  id: string;
}

interface TestDB extends WebhookOutboxDatabase<typeof TABLE | typeof CUSTOM_TABLE, Date | string> {
  outbox_kysely_users: UserTable;
}

type Dialect = KyselyAdapterOptions["dialect"];

interface Engine {
  dialect: Dialect;
  /** Fresh Kysely instance with its own connection(s). */
  connect: () => Kysely<TestDB>;
  createTable: (db: Kysely<TestDB>, table: string) => Promise<void>;
}

const postgresUrl = process.env.TYPEDHOOK_TEST_POSTGRES_URL;
const mysqlUrl = process.env.TYPEDHOOK_TEST_MYSQL_URL;
const sqliteDir = mkdtempSync(join(tmpdir(), "wh-kysely-"));

const postgres: Engine = {
  dialect: "postgres",
  connect: () =>
    new Kysely<TestDB>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: postgresUrl, max: 8 }) }),
    }),
  async createTable(db, table) {
    await sql`
      CREATE TABLE ${sql.table(table)} (
        "id" text PRIMARY KEY,
        "eventId" text NOT NULL,
        "eventType" text NOT NULL,
        "subject" text,
        "body" text NOT NULL,
        "url" text NOT NULL,
        "secret" text,
        "attempts" integer NOT NULL,
        "nextAttemptAt" timestamptz NOT NULL,
        "status" text NOT NULL,
        "lastError" text,
        "createdAt" timestamptz NOT NULL
      )`.execute(db);
    await sql`CREATE INDEX ${sql.id(`${table}_due`)} ON ${sql.table(table)} ("status", "nextAttemptAt")`.execute(db);
  },
};

const mysql: Engine = {
  dialect: "mysql",
  connect: () =>
    new Kysely<TestDB>({
      dialect: new MysqlDialect({
        pool: createPool({ uri: mysqlUrl, timezone: "Z", connectionLimit: 8 }),
      }),
    }),
  async createTable(db, table) {
    await sql`
      CREATE TABLE ${sql.table(table)} (
        id varchar(255) PRIMARY KEY,
        eventId varchar(255) NOT NULL,
        eventType varchar(255) NOT NULL,
        subject varchar(255) NULL,
        body longtext NOT NULL,
        url text NOT NULL,
        secret text NULL,
        attempts int NOT NULL,
        nextAttemptAt datetime(3) NOT NULL,
        status varchar(16) NOT NULL,
        lastError text NULL,
        createdAt datetime(3) NOT NULL,
        INDEX ${sql.id(`${table}_due`)} (status, nextAttemptAt)
      )`.execute(db);
  },
};

// A file, not :memory:, so separate connections share one database.
const sqlite: Engine = {
  dialect: "sqlite",
  connect: () => {
    const database = new Database(join(sqliteDir, "outbox.db"));
    database.run("PRAGMA busy_timeout = 5000");
    return new Kysely<TestDB>({ dialect: new BunSqliteDialect({ database }) });
  },
  async createTable(db, table) {
    await sql`
      CREATE TABLE ${sql.table(table)} (
        id TEXT PRIMARY KEY,
        eventId TEXT NOT NULL,
        eventType TEXT NOT NULL,
        subject TEXT,
        body TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT,
        attempts INTEGER NOT NULL,
        nextAttemptAt TEXT NOT NULL,
        status TEXT NOT NULL,
        lastError TEXT,
        createdAt TEXT NOT NULL
      )`.execute(db);
    await sql`CREATE INDEX ${sql.id(`${table}_due`)} ON ${sql.table(table)} (status, nextAttemptAt)`.execute(db);
  },
};

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: `obx_${crypto.randomUUID()}`,
    eventId: `evt_${crypto.randomUUID()}`,
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

const now = new Date("2026-06-01T12:00:00.000Z");

function secondsFromNow(seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

async function dropTables(db: Kysely<TestDB>) {
  await sql`DROP TABLE IF EXISTS ${sql.table(TABLE)}`.execute(db);
  await sql`DROP TABLE IF EXISTS ${sql.table(CUSTOM_TABLE)}`.execute(db);
  await sql`DROP TABLE IF EXISTS ${sql.table("outbox_kysely_users")}`.execute(db);
}

function adapterSuite(engine: Engine) {
  const { dialect } = engine;
  let db: Kysely<TestDB>;

  async function findRow(id: string, table: typeof TABLE | typeof CUSTOM_TABLE = TABLE) {
    return db.selectFrom(table).selectAll().where("id", "=", id).executeTakeFirst();
  }

  beforeAll(async () => {
    db = engine.connect();
    await dropTables(db);
    await engine.createTable(db, TABLE);
    await engine.createTable(db, CUSTOM_TABLE);
    await sql`CREATE TABLE ${sql.table("outbox_kysely_users")} (id varchar(255) PRIMARY KEY)`.execute(db);
  });

  afterAll(async () => {
    await dropTables(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom(TABLE).execute();
    await db.deleteFrom(CUSTOM_TABLE).execute();
    await db.deleteFrom("outbox_kysely_users").execute();
  });

  test("insert without tx writes through the base db", async () => {
    const adapter = kyselyOutboxAdapter(db, { dialect, table: TABLE });
    const pending = row({ subject: "user_1", secret: "s3cret" });

    await adapter.insert([pending]);

    const stored = await findRow(pending.id);
    expect(stored).toMatchObject({ id: pending.id, subject: "user_1", secret: "s3cret", status: "pending" });
  });

  test("insert inside a committed transaction persists with the caller's writes", async () => {
    const adapter = kyselyOutboxAdapter(db, { dialect, table: TABLE });
    const pending = row();

    await db.transaction().execute(async (trx) => {
      await trx.insertInto("outbox_kysely_users").values({ id: "user_1" }).execute();
      await adapter.insert([pending], trx);
    });

    expect(await findRow(pending.id)).toBeDefined();
  });

  test("insert inside a rolled-back transaction leaves no row", async () => {
    const adapter = kyselyOutboxAdapter(db, { dialect, table: TABLE });
    const pending = row();

    const rolledBack = db.transaction().execute(async (trx) => {
      await trx.insertInto("outbox_kysely_users").values({ id: "user_1" }).execute();
      await adapter.insert([pending], trx);
      throw new Error("rollback");
    });

    expect(rolledBack).rejects.toThrow("rollback");
    await rolledBack.catch(() => {});
    expect(await findRow(pending.id)).toBeUndefined();
    expect(await db.selectFrom("outbox_kysely_users").selectAll().execute()).toEqual([]);
  });

  test("claim returns only due pending rows, oldest first, up to limit", async () => {
    const adapter = kyselyOutboxAdapter(db, { dialect, table: TABLE });
    const oldest = row({ nextAttemptAt: secondsFromNow(-30) });
    const older = row({ nextAttemptAt: secondsFromNow(-20) });
    const old = row({ nextAttemptAt: secondsFromNow(-10) });
    const future = row({ nextAttemptAt: secondsFromNow(10) });
    const delivered = row({ nextAttemptAt: secondsFromNow(-60), status: "delivered" });
    const dead = row({ nextAttemptAt: secondsFromNow(-60), status: "dead" });
    await adapter.insert([old, future, oldest, delivered, older, dead]);

    const claimed = await adapter.claim(2, now);

    expect(claimed.map((claimedRow) => claimedRow.id).sort()).toEqual([oldest.id, older.id].sort());
    expect(claimed.every((claimedRow) => claimedRow.status === "pending")).toBe(true);
    expect((await adapter.claim(10, now)).map((claimedRow) => claimedRow.id)).toEqual([old.id]);
  });

  test("claimed rows stay hidden until claimTimeoutMs passes", async () => {
    const adapter = kyselyOutboxAdapter(db, { dialect, table: TABLE, claimTimeoutMs: 60_000 });
    const pending = row({ nextAttemptAt: secondsFromNow(-1) });
    await adapter.insert([pending]);

    expect((await adapter.claim(10, now)).length).toBe(1);
    expect((await adapter.claim(10, now)).length).toBe(0);
    expect((await adapter.claim(10, secondsFromNow(59))).length).toBe(0);
    expect((await adapter.claim(10, secondsFromNow(61))).map((claimedRow) => claimedRow.id)).toEqual([
      pending.id,
    ]);
    expect((await findRow(pending.id))?.status).toBe("pending");
  });

  test("claim returns full rows with dates as Date", async () => {
    const adapter = kyselyOutboxAdapter(db, { dialect, table: TABLE, claimTimeoutMs: 5_000 });
    const pending = row({
      subject: "user_1",
      body: '{"userId":"u_1"}',
      attempts: 2,
      lastError: "HTTP 500",
      nextAttemptAt: secondsFromNow(-1),
      createdAt: new Date("2026-05-01T08:30:15.123Z"),
    });
    await adapter.insert([pending]);

    const [claimed] = await adapter.claim(10, now);

    expect(claimed).toEqual({ ...pending, nextAttemptAt: secondsFromNow(5) });
    expect(claimed?.nextAttemptAt).toBeInstanceOf(Date);
    expect(claimed?.createdAt).toBeInstanceOf(Date);
  });

  test("concurrent claims on separate connections never return a row twice", async () => {
    const workerCount = 6;
    const rowCount = 300;
    const workers = Array.from({ length: workerCount }, () => engine.connect());
    const adapters = workers.map((worker) => kyselyOutboxAdapter(worker, { dialect, table: TABLE }));
    const rows = Array.from({ length: rowCount }, (_, index) =>
      row({ nextAttemptAt: new Date(now.getTime() - rowCount + index) }),
    );
    await adapters[0]!.insert(rows);

    async function drain(adapter: (typeof adapters)[number]) {
      const claimedIds: string[] = [];
      for (;;) {
        const batch = await adapter.claim(7, now);
        if (batch.length === 0) return claimedIds;
        claimedIds.push(...batch.map((claimedRow) => claimedRow.id));
      }
    }

    try {
      const claimedIds = (await Promise.all(adapters.map(drain))).flat();
      expect(claimedIds.length).toBe(rowCount);
      expect(new Set(claimedIds).size).toBe(rowCount);
    } finally {
      await Promise.all(workers.map((worker) => worker.destroy()));
    }
  });

  test("complete / retry / dead update by id; missing rows are a no-op", async () => {
    const adapter = kyselyOutboxAdapter(db, { dialect, table: TABLE });
    const pending = row();
    await adapter.insert([pending]);

    const nextAttemptAt = new Date("2026-02-01T00:00:00.000Z");
    await adapter.retry(pending.id, 3, nextAttemptAt, "boom");
    const retried = await findRow(pending.id);
    expect(retried).toMatchObject({ attempts: 3, lastError: "boom", status: "pending" });
    expect(new Date(retried!.nextAttemptAt)).toEqual(nextAttemptAt);

    await adapter.dead(pending.id, 4, "gave up");
    expect(await findRow(pending.id)).toMatchObject({ status: "dead", attempts: 4, lastError: "gave up" });

    await adapter.complete(pending.id);
    expect((await findRow(pending.id))?.status).toBe("delivered");

    await adapter.complete("obx_missing");
    await adapter.retry("obx_missing", 1, nextAttemptAt, "boom");
    await adapter.dead("obx_missing", 1, "boom");
  });

  test("custom table name is honored", async () => {
    const adapter = kyselyOutboxAdapter(db, { dialect, table: CUSTOM_TABLE });
    const pending = row({ nextAttemptAt: secondsFromNow(-1) });

    await adapter.insert([pending]);

    expect(await findRow(pending.id, TABLE)).toBeUndefined();
    expect(await findRow(pending.id, CUSTOM_TABLE)).toBeDefined();
    expect((await adapter.claim(10, now)).map((claimedRow) => claimedRow.id)).toEqual([pending.id]);
  });

  test("send() inside a transaction enqueues, worker tick delivers", async () => {
    const received: { body: string; signature: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push({ body: await request.text(), signature: request.headers.get("webhook-signature") });
        return new Response(null, { status: 200 });
      },
    });

    try {
      const wh = webhooks({
        events: { "user.created": z.object({ userId: z.string() }) },
        subscribers: [{ url: `http://localhost:${server.port}/hook` }],
        signing: { secret: "s3cret" },
        delivery: outbox(kyselyOutboxAdapter(db, { dialect, table: TABLE })),
      });

      await db.transaction().execute(async (trx) => {
        await trx.insertInto("outbox_kysely_users").values({ id: "u_1" }).execute();
        const sent = await wh.with(trx).send({
          event: "user.created",
          subject: "u_1",
          data: { userId: "u_1" },
        });
        expect(sent.ok).toBe(true);
      });

      const report = await wh.worker().tick();

      expect(report).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
      expect(received.length).toBe(1);
      expect(received[0]!.body).toContain(`"userId":"u_1"`);
      const [stored] = await db.selectFrom(TABLE).selectAll().execute();
      expect(stored?.status).toBe("delivered");
    } finally {
      server.stop(true);
    }
  });
}

describe.skipIf(!postgresUrl)("kyselyOutboxAdapter on Postgres", () => adapterSuite(postgres));
describe.skipIf(!mysqlUrl)("kyselyOutboxAdapter on MySQL", () => adapterSuite(mysql));
describe("kyselyOutboxAdapter on SQLite (bun:sqlite)", () => {
  adapterSuite(sqlite);
  // Registered after the suite's own afterAll, which still needs the file.
  afterAll(() => rmSync(sqliteDir, { recursive: true, force: true }));
});

describe("kyselyOutboxAdapter options", () => {
  test("rejects table names that aren't plain identifiers", () => {
    const db = new Kysely<TestDB>({ dialect: new BunSqliteDialect({ database: new Database(":memory:") }) });
    expect(() => kyselyOutboxAdapter(db, { dialect: "sqlite", table: 'x"; DROP TABLE y;--' })).toThrow(
      "plain SQL identifier",
    );
  });

  test("works with CamelCasePlugin over snake_case columns", async () => {
    const db = new Kysely<TestDB>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
      plugins: [new CamelCasePlugin()],
    });
    await sql`
      CREATE TABLE outbox_kysely (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, event_type TEXT NOT NULL, subject TEXT,
        body TEXT NOT NULL, url TEXT NOT NULL, secret TEXT, attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL, status TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL
      )`.execute(db);
    const adapter = kyselyOutboxAdapter(db, { dialect: "sqlite", table: TABLE, claimTimeoutMs: 5_000 });
    const pending = row({ nextAttemptAt: secondsFromNow(-1) });

    await adapter.insert([pending]);
    const claimed = await adapter.claim(10, now);
    await adapter.retry(pending.id, 1, secondsFromNow(30), "boom");

    expect(claimed).toEqual([{ ...pending, nextAttemptAt: secondsFromNow(5) }]);
    expect(await db.selectFrom(TABLE).select(["attempts", "lastError"]).execute()).toEqual([
      { attempts: 1, lastError: "boom" },
    ]);
    await db.destroy();
  });

  test("with() is typed as the db's Transaction", () => {
    const db = new Kysely<TestDB>({ dialect: new BunSqliteDialect({ database: new Database(":memory:") }) });
    const wh = webhooks({
      events: { "user.created": z.object({ userId: z.string() }) },
      subscribers: [{ url: "https://consumer.test/hook" }],
      signing: { secret: "s3cret" },
      delivery: outbox(kyselyOutboxAdapter(db, { dialect: "sqlite" })),
    });

    // @ts-expect-error — with() takes a Kysely Transaction, not an arbitrary object
    expect(() => wh.with({ query: "nope" })).not.toThrow();
  });
});
