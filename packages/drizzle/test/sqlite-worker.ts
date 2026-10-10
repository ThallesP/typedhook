/**
 * One claiming worker on its own thread and connection, so SQLite claims
 * really contend. Posts "ready", waits for a start message, claims until the
 * table is empty, then posts the ids it got.
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { drizzleOutboxAdapter } from "../src/index";
import { claimUntilEmpty } from "./contract";
import { TABLE, sqliteOutbox } from "./schema";

declare const self: Worker;

export interface ClaimRequest {
  path: string;
  limit: number;
  nowMs: number;
}

self.onmessage = async (event: MessageEvent<ClaimRequest>) => {
  const { path, limit, nowMs } = event.data;
  const client = new Database(path);
  client.run("PRAGMA busy_timeout = 5000");
  const adapter = drizzleOutboxAdapter(drizzle({ client }), { table: sqliteOutbox(TABLE) });
  const ids = await claimUntilEmpty(adapter, limit, new Date(nowMs));
  client.close();
  self.postMessage(ids);
};

self.postMessage("ready");
