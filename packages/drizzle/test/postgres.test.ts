import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { drizzleOutboxAdapter } from "../src/index";
import { claimUntilEmpty, outboxContract } from "./contract";
import { CUSTOM_TABLE, TABLE, pgOutbox, pgOutboxDdl, sqliteOutbox } from "./schema";

const url = process.env.TYPEDHOOK_TEST_POSTGRES_URL;

describe.skipIf(!url)("drizzleOutboxAdapter on Postgres", () => {
  const outboxTable = pgOutbox(TABLE);
  const customTable = pgOutbox(CUSTOM_TABLE);
  const pool = new Pool({ connectionString: url, max: 10 });
  const db = drizzle({ client: pool });

  async function dropTables() {
    await pool.query(`DROP TABLE IF EXISTS "${TABLE}", "${CUSTOM_TABLE}"`);
  }

  outboxContract(async () => {
    await dropTables();
    for (const statement of [...pgOutboxDdl(TABLE), ...pgOutboxDdl(CUSTOM_TABLE)]) {
      await pool.query(statement);
    }
    const adapter = drizzleOutboxAdapter(db, { table: outboxTable });
    return {
      adapter,
      customAdapter: drizzleOutboxAdapter(db, { table: customTable }),
      transaction: (run) => db.transaction(run),
      async findRow(rowId) {
        const [found] = await db.select().from(outboxTable).where(eq(outboxTable.id, rowId));
        return found;
      },
      claimConcurrently(workerCount, limit, now) {
        // the pool hands each parallel claim its own connection
        return Promise.all(
          Array.from({ length: workerCount }, () => claimUntilEmpty(adapter, limit, now)),
        );
      },
      async reset() {
        await pool.query(`TRUNCATE "${TABLE}", "${CUSTOM_TABLE}"`);
      },
      async close() {
        await dropTables();
        await pool.end();
      },
    };
  });

  test("rejects a table from another dialect", () => {
    // @ts-expect-error a sqliteTable can't back a Postgres adapter
    expect(() => drizzleOutboxAdapter(db, { table: sqliteOutbox(TABLE) })).toThrow(
      "a table from the same dialect",
    );
  });
});
