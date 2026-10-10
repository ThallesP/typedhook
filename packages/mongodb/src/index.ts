import type { OutboxAdapter, OutboxRow } from "@typedhook/sdk";
import type { ClientSession, Db } from "mongodb";

/**
 * How a row is stored: the row id is the document `_id`, so it's unique
 * without an extra index and lookups by id hit the default `_id` index.
 */
export type OutboxDocument = Omit<OutboxRow, "id"> & { _id: string };

export interface MongoAdapterOptions {
  /** Collection name. Default "webhookOutbox". */
  collection?: string;
  /**
   * How long claimed rows stay invisible to other workers before a crashed
   * worker's rows become due again. Must exceed the worker's delivery
   * timeoutMs. Default 60_000.
   */
  claimTimeoutMs?: number;
}

// MongoDB's own collection name rules. The driver only rejects a bad name on
// the first operation, which would surface inside the worker instead of at boot.
const COLLECTION_NAME = /^(?!system\.)[^$\0]+$/;

function toDocument({ id, ...row }: OutboxRow): OutboxDocument {
  return { _id: id, ...row };
}

function toRow({ _id, ...document }: OutboxDocument): OutboxRow {
  return { id: _id, ...document };
}

/**
 * Claims with one atomic `findOneAndUpdate` per row (MongoDB has no
 * `SKIP LOCKED`), so concurrent workers never grab the same row. Rows stay
 * `pending` while claimed; their nextAttemptAt is pushed claimTimeoutMs into
 * the future, so a crashed worker's rows are redelivered after the timeout
 * (at-least-once).
 *
 * `with(tx)` takes a `ClientSession`; insert joins its transaction. See the
 * README for the index to create.
 */
export function mongodbOutboxAdapter<Tx extends ClientSession = ClientSession>(
  db: Db,
  options: MongoAdapterOptions = {},
): OutboxAdapter<Tx> {
  const collectionName = options.collection ?? "webhookOutbox";
  const claimTimeoutMs = options.claimTimeoutMs ?? 60_000;
  if (!COLLECTION_NAME.test(collectionName)) {
    throw new Error(
      `invalid collection name "${collectionName}": must be non-empty, contain no "$" or null characters, and not start with "system."`,
    );
  }
  const collection = db.collection<OutboxDocument>(collectionName);

  return {
    async insert(rows, tx) {
      await collection.insertMany(rows.map(toDocument), { session: tx });
    },
    async claim(limit, now) {
      const claimedUntil = new Date(now.getTime() + claimTimeoutMs);
      const claimed: OutboxRow[] = [];
      while (claimed.length < limit) {
        const document = await collection.findOneAndUpdate(
          { status: "pending", nextAttemptAt: { $lte: now } },
          { $set: { nextAttemptAt: claimedUntil } },
          { sort: { nextAttemptAt: 1 }, returnDocument: "after" },
        );
        if (!document) break;
        // nextAttemptAt on the returned row is the bumped claim horizon, not
        // the original schedule — the worker never reads it, hooks might.
        claimed.push(toRow(document));
      }
      return claimed;
    },
    async complete(rowId) {
      await collection.updateOne({ _id: rowId }, { $set: { status: "delivered" } });
    },
    async retry(rowId, attempts, nextAttemptAt, lastError) {
      await collection.updateOne(
        { _id: rowId },
        { $set: { attempts, nextAttemptAt, lastError } },
      );
    },
    async dead(rowId, attempts, lastError) {
      await collection.updateOne(
        { _id: rowId },
        { $set: { status: "dead", attempts, lastError } },
      );
    },
  };
}
