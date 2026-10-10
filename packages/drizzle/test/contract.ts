/**
 * One adapter contract, run against every dialect on a real database.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { outbox, webhooks, type OutboxAdapter, type OutboxRow } from "@thallesp/webhooks";
import { z } from "zod";

export interface Harness<Tx> {
  /** Adapter over the default test table. */
  adapter: OutboxAdapter<Tx>;
  /** Adapter over a second table with another name. */
  customAdapter: OutboxAdapter<Tx>;
  transaction: <T>(run: (tx: Tx) => Promise<T>) => Promise<T>;
  findRow: (rowId: string) => Promise<OutboxRow | undefined>;
  /**
   * Runs `workerCount` claimUntilEmpty loops in parallel, each on its own
   * connection, and returns the ids each one claimed.
   */
  claimConcurrently: (workerCount: number, limit: number, now: Date) => Promise<string[][]>;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: `obx_${crypto.randomUUID()}`,
    eventId: `evt_${crypto.randomUUID()}`,
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

export async function claimUntilEmpty(
  adapter: OutboxAdapter<never>,
  limit: number,
  now: Date,
): Promise<string[]> {
  const ids: string[] = [];
  for (;;) {
    const claimed = await adapter.claim(limit, now);
    if (claimed.length === 0) return ids;
    ids.push(...claimed.map((claimedRow) => claimedRow.id));
  }
}

class Rollback extends Error {}

export function outboxContract<Tx>(setup: () => Promise<Harness<Tx>>) {
  let harness: Harness<Tx>;

  beforeAll(async () => {
    harness = await setup();
  });
  beforeEach(async () => {
    await harness.reset();
  });
  afterAll(async () => {
    await harness.close();
  });

  test("insert without tx writes through the base db", async () => {
    const pending = row({ subject: "user_1", secret: "whsec_1" });

    await harness.adapter.insert([pending]);

    expect(await harness.findRow(pending.id)).toEqual(pending);
  });

  test("insert inside a committed transaction is visible", async () => {
    const pending = row();

    await harness.transaction((tx) => harness.adapter.insert([pending], tx));

    expect(await harness.findRow(pending.id)).toEqual(pending);
  });

  test("insert inside a rolled-back transaction leaves nothing behind", async () => {
    const pending = row();

    const rolledBack = harness.transaction(async (tx) => {
      await harness.adapter.insert([pending], tx);
      throw new Rollback();
    });

    expect(rolledBack).rejects.toBeInstanceOf(Rollback);
    await rolledBack.catch(() => {});
    expect(await harness.findRow(pending.id)).toBeUndefined();
  });

  test("claim returns only due pending rows, earliest first, up to the limit", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const earliest = row({ nextAttemptAt: new Date("2026-05-01T00:00:00Z") });
    const middle = row({ nextAttemptAt: new Date("2026-05-02T00:00:00Z") });
    const latest = row({ nextAttemptAt: new Date("2026-05-03T00:00:00Z") });
    const future = row({ nextAttemptAt: new Date("2026-07-01T00:00:00Z") });
    const delivered = row({ status: "delivered" });
    const dead = row({ status: "dead" });
    await harness.adapter.insert([latest, future, delivered, middle, dead, earliest]);

    const claimed = await harness.adapter.claim(2, now);

    expect(claimed.map((claimedRow) => claimedRow.id).sort()).toEqual(
      [earliest.id, middle.id].sort(),
    );
    for (const claimedRow of claimed) expect(claimedRow.status).toBe("pending");
  });

  test("claimed rows stay hidden until claimTimeoutMs passes", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const pending = row();
    await harness.adapter.insert([pending]);

    expect((await harness.adapter.claim(10, now)).length).toBe(1);
    expect((await harness.adapter.claim(10, now)).length).toBe(0);
    expect((await harness.adapter.claim(10, new Date(now.getTime() + 59_000))).length).toBe(0);

    const reclaimed = await harness.adapter.claim(10, new Date(now.getTime() + 61_000));
    expect(reclaimed.map((claimedRow) => claimedRow.id)).toEqual([pending.id]);
    expect((await harness.findRow(pending.id))?.status).toBe("pending");
  });

  test("claim returns Date columns and the bumped claim horizon", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const pending = row({ subject: "user_1" });
    await harness.adapter.insert([pending]);

    const [claimed] = await harness.adapter.claim(1, now);

    expect(claimed).toEqual({ ...pending, nextAttemptAt: new Date(now.getTime() + 60_000) });
    expect(claimed?.createdAt).toBeInstanceOf(Date);
    expect(claimed?.nextAttemptAt).toBeInstanceOf(Date);
  });

  test("concurrent claims on separate connections never return a row twice", async () => {
    const rowCount = 300;
    await harness.adapter.insert(
      Array.from({ length: rowCount }, (_, index) =>
        row({ nextAttemptAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)) }),
      ),
    );

    const claimedIds = await harness.claimConcurrently(8, 7, new Date("2026-06-01T00:00:00Z"));

    const allIds = claimedIds.flat();
    expect(allIds.length).toBe(rowCount);
    expect(new Set(allIds).size).toBe(rowCount);
    // more than one worker got rows, so the claims really overlapped
    expect(claimedIds.filter((ids) => ids.length > 0).length).toBeGreaterThan(1);
  });

  test("complete / retry / dead update the row by id", async () => {
    const pending = row();
    await harness.adapter.insert([pending]);

    const nextAttemptAt = new Date("2026-02-01T00:00:00.789Z");
    await harness.adapter.retry(pending.id, 3, nextAttemptAt, "boom");
    expect(await harness.findRow(pending.id)).toMatchObject({
      attempts: 3,
      nextAttemptAt,
      lastError: "boom",
      status: "pending",
    });

    await harness.adapter.dead(pending.id, 4, "gave up");
    expect(await harness.findRow(pending.id)).toMatchObject({
      status: "dead",
      attempts: 4,
      lastError: "gave up",
    });

    await harness.adapter.complete(pending.id);
    expect((await harness.findRow(pending.id))?.status).toBe("delivered");
  });

  test("complete / retry / dead on a missing row are no-ops", async () => {
    await harness.adapter.complete("obx_missing");
    await harness.adapter.retry("obx_missing", 1, new Date(), "boom");
    await harness.adapter.dead("obx_missing", 1, "gave up");
  });

  test("custom table is the one written and claimed", async () => {
    const pending = row();

    await harness.customAdapter.insert([pending]);

    expect(await harness.findRow(pending.id)).toBeUndefined();
    expect((await harness.adapter.claim(10, new Date())).length).toBe(0);
    const claimed = await harness.customAdapter.claim(10, new Date());
    expect(claimed.map((claimedRow) => claimedRow.id)).toEqual([pending.id]);
  });

  test("end to end: with(tx).send() enqueues, worker tick delivers to a real server", async () => {
    const received: { body: string; webhookId: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push({
          body: await request.text(),
          webhookId: request.headers.get("webhook-id"),
        });
        return new Response(null, { status: 204 });
      },
    });
    try {
      const wh = webhooks({
        events: { "user.created": z.object({ userId: z.string() }) },
        subscribers: [{ url: `http://localhost:${server.port}/hook` }],
        signing: { secret: "s3cret" },
        delivery: outbox(harness.adapter),
      });

      const sent = await harness.transaction((tx) =>
        wh.with(tx).send({ event: "user.created", subject: "user_1", data: { userId: "u_1" } }),
      );
      expect(sent.ok).toBe(true);

      const report = await wh.worker().tick();

      expect(report).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
      expect(received.length).toBe(1);
      expect(JSON.parse(received[0]!.body).data).toEqual({ userId: "u_1" });
      expect((await wh.worker().tick()).claimed).toBe(0);
    } finally {
      server.stop(true);
    }
  });
}
