/**
 * Compile-time contract. Checked by `tsc --noEmit`, never executed.
 * The load-bearing claim: the transaction type is inferred from the db, so
 * `with(tx)` rejects anything that isn't a transaction of that database.
 */
import { outbox, webhooks } from "@thallesp/webhooks";
import { drizzle as drizzleSqlite } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { drizzleOutboxAdapter } from "../src/index";
import { TABLE, mysqlOutbox, pgOutbox, sqliteOutbox } from "./schema";

const events = { "user.created": z.object({ userId: z.string() }) };
const input = { event: "user.created", subject: "user_1", data: { userId: "u_1" } } as const;

export async function postgresWithTakesOnlyAPostgresTransaction() {
  const pg = drizzlePg("postgres://localhost/db");
  const mysql = drizzleMysql("mysql://localhost/db");
  const wh = webhooks({
    events,
    subscribers: [],
    signing: { secret: "s" },
    delivery: outbox(drizzleOutboxAdapter(pg, { table: pgOutbox(TABLE) })),
  });

  await pg.transaction((tx) => wh.with(tx).send(input));

  await mysql.transaction(async (tx) => {
    // @ts-expect-error a MySQL transaction can't enqueue into a Postgres outbox
    await wh.with(tx).send(input);
  });

  // @ts-expect-error not a transaction at all
  await wh.with({}).send(input);
}

export async function mysqlWithTakesOnlyAMysqlTransaction() {
  const pg = drizzlePg("postgres://localhost/db");
  const mysql = drizzleMysql("mysql://localhost/db");
  const wh = webhooks({
    events,
    subscribers: [],
    signing: { secret: "s" },
    delivery: outbox(drizzleOutboxAdapter(mysql, { table: mysqlOutbox(TABLE) })),
  });

  await mysql.transaction((tx) => wh.with(tx).send(input));

  await pg.transaction(async (tx) => {
    // @ts-expect-error a Postgres transaction can't enqueue into a MySQL outbox
    await wh.with(tx).send(input);
  });
}

export async function sqliteWithTakesTheDbOrATransaction() {
  const sqlite = drizzleSqlite(":memory:");
  const pg = drizzlePg("postgres://localhost/db");
  const wh = webhooks({
    events,
    subscribers: [],
    signing: { secret: "s" },
    delivery: outbox(drizzleOutboxAdapter(sqlite, { table: sqliteOutbox(TABLE) })),
  });

  // sync drivers can't await inside db.transaction, so the db itself is
  // accepted for a manual BEGIN/COMMIT
  await wh.with(sqlite).send(input);

  await pg.transaction(async (tx) => {
    // @ts-expect-error a Postgres transaction can't enqueue into a SQLite outbox
    await wh.with(tx).send(input);
  });
}

export function tableMustMatchTheDialect() {
  const pg = drizzlePg("postgres://localhost/db");

  // @ts-expect-error a mysqlTable can't back a Postgres adapter
  drizzleOutboxAdapter(pg, { table: mysqlOutbox(TABLE) });
}
