import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createPool } from "mysql2/promise";
import { drizzleOutboxAdapter } from "../src/index";
import { claimUntilEmpty, outboxContract } from "./contract";
import { CUSTOM_TABLE, TABLE, mysqlOutbox, mysqlOutboxDdl, pgOutbox } from "./schema";

const url = process.env.WEBHOOKS_TEST_MYSQL_URL;

describe.skipIf(!url)("drizzleOutboxAdapter on MySQL", () => {
  const outboxTable = mysqlOutbox(TABLE);
  const customTable = mysqlOutbox(CUSTOM_TABLE);
  const pool = createPool({ uri: url, connectionLimit: 10 });
  const db = drizzle({ client: pool });

  async function dropTables() {
    await pool.query(`DROP TABLE IF EXISTS \`${TABLE}\`, \`${CUSTOM_TABLE}\``);
  }

  outboxContract(async () => {
    await dropTables();
    for (const statement of [...mysqlOutboxDdl(TABLE), ...mysqlOutboxDdl(CUSTOM_TABLE)]) {
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
        // the pool hands each parallel claim transaction its own connection
        return Promise.all(
          Array.from({ length: workerCount }, () => claimUntilEmpty(adapter, limit, now)),
        );
      },
      async reset() {
        // DELETE, not TRUNCATE: TRUNCATE recreates the table, ~0.3s each
        await pool.query(`DELETE FROM \`${TABLE}\``);
        await pool.query(`DELETE FROM \`${CUSTOM_TABLE}\``);
      },
      async close() {
        await dropTables();
        await pool.end();
      },
    };
  });

  test("rejects a table from another dialect", () => {
    // @ts-expect-error a pgTable can't back a MySQL adapter
    expect(() => drizzleOutboxAdapter(db, { table: pgOutbox(TABLE) })).toThrow(
      "a table from the same dialect",
    );
  });
});
