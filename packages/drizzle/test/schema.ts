/**
 * The README table definitions, parameterized by name so each suite can make
 * a default and a custom table. Shared CI databases hold every adapter's
 * tables, so names stay unique to this package.
 */
import * as mysql from "drizzle-orm/mysql-core";
import * as pg from "drizzle-orm/pg-core";
import * as sqlite from "drizzle-orm/sqlite-core";

export const TABLE = "outbox_drizzle";
export const CUSTOM_TABLE = "outbox_drizzle_custom";

export function pgOutbox(name: string) {
  return pg.pgTable(
    name,
    {
      id: pg.text("id").primaryKey(),
      eventId: pg.text("event_id").notNull(),
      eventType: pg.text("event_type").notNull(),
      subject: pg.text("subject"),
      body: pg.text("body").notNull(),
      url: pg.text("url").notNull(),
      secret: pg.text("secret"),
      attempts: pg.integer("attempts").notNull(),
      nextAttemptAt: pg.timestamp("next_attempt_at", { withTimezone: true }).notNull(),
      status: pg.text("status", { enum: ["pending", "delivered", "dead"] }).notNull(),
      lastError: pg.text("last_error"),
      createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull(),
    },
    (table) => [pg.index(`${name}_due_idx`).on(table.status, table.nextAttemptAt)],
  );
}

export function pgOutboxDdl(name: string) {
  return [
    `CREATE TABLE "${name}" (
      "id" text PRIMARY KEY,
      "event_id" text NOT NULL,
      "event_type" text NOT NULL,
      "subject" text,
      "body" text NOT NULL,
      "url" text NOT NULL,
      "secret" text,
      "attempts" integer NOT NULL,
      "next_attempt_at" timestamp with time zone NOT NULL,
      "status" text NOT NULL,
      "last_error" text,
      "created_at" timestamp with time zone NOT NULL
    )`,
    `CREATE INDEX "${name}_due_idx" ON "${name}" ("status", "next_attempt_at")`,
  ];
}

export function mysqlOutbox(name: string) {
  return mysql.mysqlTable(
    name,
    {
      id: mysql.varchar("id", { length: 255 }).primaryKey(),
      eventId: mysql.varchar("event_id", { length: 255 }).notNull(),
      eventType: mysql.varchar("event_type", { length: 255 }).notNull(),
      subject: mysql.varchar("subject", { length: 255 }),
      body: mysql.longtext("body").notNull(),
      url: mysql.text("url").notNull(),
      secret: mysql.text("secret"),
      attempts: mysql.int("attempts").notNull(),
      nextAttemptAt: mysql.datetime("next_attempt_at", { mode: "date", fsp: 3 }).notNull(),
      status: mysql
        .varchar("status", { length: 16, enum: ["pending", "delivered", "dead"] })
        .notNull(),
      lastError: mysql.text("last_error"),
      createdAt: mysql.datetime("created_at", { mode: "date", fsp: 3 }).notNull(),
    },
    (table) => [mysql.index(`${name}_due_idx`).on(table.status, table.nextAttemptAt)],
  );
}

export function mysqlOutboxDdl(name: string) {
  return [
    `CREATE TABLE \`${name}\` (
      \`id\` varchar(255) PRIMARY KEY,
      \`event_id\` varchar(255) NOT NULL,
      \`event_type\` varchar(255) NOT NULL,
      \`subject\` varchar(255),
      \`body\` longtext NOT NULL,
      \`url\` text NOT NULL,
      \`secret\` text,
      \`attempts\` int NOT NULL,
      \`next_attempt_at\` datetime(3) NOT NULL,
      \`status\` varchar(16) NOT NULL,
      \`last_error\` text,
      \`created_at\` datetime(3) NOT NULL,
      INDEX \`${name}_due_idx\` (\`status\`, \`next_attempt_at\`)
    )`,
  ];
}

export function sqliteOutbox(name: string) {
  return sqlite.sqliteTable(
    name,
    {
      id: sqlite.text("id").primaryKey(),
      eventId: sqlite.text("event_id").notNull(),
      eventType: sqlite.text("event_type").notNull(),
      subject: sqlite.text("subject"),
      body: sqlite.text("body").notNull(),
      url: sqlite.text("url").notNull(),
      secret: sqlite.text("secret"),
      attempts: sqlite.integer("attempts").notNull(),
      nextAttemptAt: sqlite.integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
      status: sqlite.text("status", { enum: ["pending", "delivered", "dead"] }).notNull(),
      lastError: sqlite.text("last_error"),
      createdAt: sqlite.integer("created_at", { mode: "timestamp_ms" }).notNull(),
    },
    (table) => [sqlite.index(`${name}_due_idx`).on(table.status, table.nextAttemptAt)],
  );
}

export function sqliteOutboxDdl(name: string) {
  return [
    `CREATE TABLE "${name}" (
      "id" text PRIMARY KEY NOT NULL,
      "event_id" text NOT NULL,
      "event_type" text NOT NULL,
      "subject" text,
      "body" text NOT NULL,
      "url" text NOT NULL,
      "secret" text,
      "attempts" integer NOT NULL,
      "next_attempt_at" integer NOT NULL,
      "status" text NOT NULL,
      "last_error" text,
      "created_at" integer NOT NULL
    )`,
    `CREATE INDEX "${name}_due_idx" ON "${name}" ("status", "next_attempt_at")`,
  ];
}
