import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { drizzleOutboxAdapter } from "../src/index";
import { outboxContract } from "./contract";
import { CUSTOM_TABLE, TABLE, mysqlOutbox, sqliteOutbox, sqliteOutboxDdl } from "./schema";
import type { ClaimRequest } from "./sqlite-worker";

// A file, not :memory:, so worker threads can open their own connections.
const dir = mkdtempSync(join(tmpdir(), "webhooks-drizzle-"));
const path = join(dir, "outbox.db");

function claimOnWorkerThreads(workerCount: number, request: ClaimRequest) {
  const workers = Array.from(
    { length: workerCount },
    () => new Worker(new URL("./sqlite-worker.ts", import.meta.url)),
  );
  const ready = workers.map(
    (worker) => new Promise<void>((resolve) => worker.addEventListener("message", () => resolve(), { once: true })),
  );
  return Promise.all(ready).then(() =>
    Promise.all(
      workers.map(
        (worker) =>
          new Promise<string[]>((resolve, reject) => {
            worker.addEventListener("message", (event) => resolve(event.data), { once: true });
            worker.addEventListener("error", reject, { once: true });
            worker.postMessage(request);
          }),
      ),
    ).finally(() => {
      for (const worker of workers) worker.terminate();
    }),
  );
}

describe("drizzleOutboxAdapter on SQLite (bun:sqlite)", () => {
  const outboxTable = sqliteOutbox(TABLE);
  const customTable = sqliteOutbox(CUSTOM_TABLE);
  const client = new Database(path);
  client.run("PRAGMA journal_mode = WAL");
  client.run("PRAGMA busy_timeout = 5000");
  const db = drizzle({ client });

  outboxContract(async () => {
    for (const statement of [...sqliteOutboxDdl(TABLE), ...sqliteOutboxDdl(CUSTOM_TABLE)]) {
      client.run(statement);
    }
    return {
      adapter: drizzleOutboxAdapter(db, { table: outboxTable }),
      customAdapter: drizzleOutboxAdapter(db, { table: customTable }),
      // bun:sqlite is synchronous, so drizzle's db.transaction can't await
      // inside its callback; the README's manual BEGIN/COMMIT is the pattern.
      async transaction(run) {
        db.run(sql`BEGIN IMMEDIATE`);
        try {
          const result = await run(db);
          db.run(sql`COMMIT`);
          return result;
        } catch (error) {
          db.run(sql`ROLLBACK`);
          throw error;
        }
      },
      async findRow(rowId) {
        const [found] = await db.select().from(outboxTable).where(eq(outboxTable.id, rowId));
        return found;
      },
      claimConcurrently(workerCount, limit, now) {
        return claimOnWorkerThreads(workerCount, { path, limit, nowMs: now.getTime() });
      },
      async reset() {
        client.run(`DELETE FROM "${TABLE}"`);
        client.run(`DELETE FROM "${CUSTOM_TABLE}"`);
      },
      async close() {
        client.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  });

  test("rejects a table from another dialect", () => {
    // @ts-expect-error a mysqlTable can't back a SQLite adapter
    expect(() => drizzleOutboxAdapter(db, { table: mysqlOutbox(TABLE) })).toThrow(
      "a table from the same dialect",
    );
  });
});
