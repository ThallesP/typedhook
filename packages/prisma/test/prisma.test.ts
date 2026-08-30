import { describe, expect, test } from "bun:test";
import type { OutboxRow } from "@thallesp/webhooks";
import { prismaOutboxAdapter } from "../src/index";

/**
 * Fake PrismaClient: real in-memory rows behind the delegate + a
 * $queryRawUnsafe that executes the claim query's semantics, so the adapter
 * runs end-to-end without Postgres. SKIP LOCKED itself needs a real database.
 */
function fakePrisma() {
  const rows: OutboxRow[] = [];
  const calls: { method: string; args: unknown }[] = [];

  const delegate = (txTag?: string) => ({
    async createMany(args: { data: OutboxRow[] }) {
      calls.push({ method: `createMany${txTag ?? ""}`, args });
      rows.push(...args.data.map((row) => ({ ...row })));
      return { count: args.data.length };
    },
    async updateMany(args: { where: { id: string }; data: Partial<OutboxRow> }) {
      calls.push({ method: "updateMany", args });
      const index = rows.findIndex((row) => row.id === args.where.id);
      if (index >= 0) rows[index] = { ...rows[index]!, ...args.data };
      return { count: index >= 0 ? 1 : 0 };
    },
  });

  const client = {
    rows,
    calls,
    lastSql: "",
    webhookOutbox: delegate(),
    async $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown> {
      client.lastSql = query;
      const [claimedUntil, now, limit] = values as [Date, Date, number];
      const due = rows
        .filter(
          (row) =>
            row.status === "pending" && row.nextAttemptAt.getTime() <= now.getTime(),
        )
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
        .slice(0, limit);
      for (const row of due) row.nextAttemptAt = claimedUntil;
      return due.map((row) => ({ ...row }));
    },
  };
  return client;
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

describe("prismaOutboxAdapter", () => {
  test("insert without tx uses the client's delegate", async () => {
    const client = fakePrisma();
    const adapter = prismaOutboxAdapter(client);

    await adapter.insert([row()]);

    expect(client.rows.length).toBe(1);
    expect(client.calls[0]!.method).toBe("createMany");
  });

  test("insert with tx uses the transaction's delegate, not the client's", async () => {
    const client = fakePrisma();
    const txStore = fakePrisma();
    const tx = { webhookOutbox: txStore.webhookOutbox };
    const adapter = prismaOutboxAdapter<typeof tx>(client);

    await adapter.insert([row()], tx);

    expect(txStore.rows.length).toBe(1);
    expect(client.rows.length).toBe(0);
  });

  test("claim issues SKIP LOCKED SQL against the configured table and hides claimed rows", async () => {
    const client = fakePrisma();
    const adapter = prismaOutboxAdapter(client, { claimTimeoutMs: 60_000 });
    await adapter.insert([row(), row({ nextAttemptAt: new Date("2999-01-01") })]);

    const now = new Date();
    const claimed = await adapter.claim(10, now);

    expect(client.lastSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(client.lastSql).toContain('"WebhookOutbox"');
    expect(claimed.length).toBe(1);
    expect(claimed[0]!.status).toBe("pending");
    // claimed row is invisible to a second worker until the timeout passes
    expect((await adapter.claim(10, now)).length).toBe(0);
    expect((await adapter.claim(10, new Date(now.getTime() + 61_000))).length).toBe(1);
  });

  test("claim coerces date columns that arrive as strings", async () => {
    const client = fakePrisma();
    const adapter = prismaOutboxAdapter(client);
    const raw = { ...row(), nextAttemptAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" };
    client.$queryRawUnsafe = async () => [raw];

    const claimed = await adapter.claim(10, new Date());

    expect(claimed[0]!.nextAttemptAt).toBeInstanceOf(Date);
    expect(claimed[0]!.createdAt).toBeInstanceOf(Date);
  });

  test("complete / retry / dead update the row through the delegate", async () => {
    const client = fakePrisma();
    const adapter = prismaOutboxAdapter(client);
    const pending = row();
    await adapter.insert([pending]);

    const nextAttemptAt = new Date("2026-02-01");
    await adapter.retry(pending.id, 3, nextAttemptAt, "boom");
    expect(client.rows[0]).toMatchObject({ attempts: 3, nextAttemptAt, lastError: "boom" });

    await adapter.dead(pending.id, 4, "gave up");
    expect(client.rows[0]).toMatchObject({ status: "dead", attempts: 4, lastError: "gave up" });

    await adapter.complete(pending.id);
    expect(client.rows[0]!.status).toBe("delivered");
  });

  test("custom model and table names are honored", async () => {
    const client = fakePrisma();
    const custom = {
      outboxRows: client.webhookOutbox,
      $queryRawUnsafe: client.$queryRawUnsafe,
    };
    const adapter = prismaOutboxAdapter(custom, { model: "outboxRows", table: "outbox_rows" });

    await adapter.insert([row()]);
    await adapter.claim(1, new Date());

    expect(client.rows.length).toBe(1);
    expect(client.lastSql).toContain('"outbox_rows"');
  });

  test("missing model delegate throws a pointed error", async () => {
    const client = fakePrisma();
    const adapter = prismaOutboxAdapter(client, { model: "nope" });
    expect(adapter.insert([row()])).rejects.toThrow('no model delegate "nope"');
  });

  test("rejects table names that aren't plain identifiers", () => {
    const client = fakePrisma();
    expect(() => prismaOutboxAdapter(client, { table: 'x"; DROP TABLE y;--' })).toThrow(
      "plain SQL identifier",
    );
  });
});

describe("end-to-end with webhooks()", () => {
  test("send() enqueues via prisma, worker tick delivers", async () => {
    const { webhooks, outbox } = await import("@thallesp/webhooks");
    const { z } = await import("zod");
    const client = fakePrisma();
    const adapter = prismaOutboxAdapter(client);

    const wh = webhooks({
      events: { "user.created": z.object({ userId: z.string() }) },
      subscribers: [{ url: "https://consumer.test/hook" }],
      subject: "optional",
      signing: { secret: "s3cret" },
      delivery: outbox(adapter),
    });

    const sent = await wh.send({ event: "user.created", data: { userId: "u_1" } });
    expect(sent.ok).toBe(true);
    expect(client.rows.length).toBe(1);

    const fetchImpl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const report = await wh.worker({ fetchImpl }).tick();

    expect(report).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
    expect(client.rows[0]!.status).toBe("delivered");
  });
});
