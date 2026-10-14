import { expect, test } from "bun:test";
import { memoryAdapter, outbox } from "@typedhook/sdk";
import { OUTBOX_MAX_ATTEMPTS, outboxBackoffSec } from "./outbox-defaults";

test("the playground uses the SDK's outbox defaults", () => {
  const delivery = outbox(memoryAdapter());

  expect(OUTBOX_MAX_ATTEMPTS).toBe(delivery.maxAttempts);
  for (let failedAttempts = 1; failedAttempts <= delivery.maxAttempts; failedAttempts++) {
    expect(outboxBackoffSec(failedAttempts) * 1_000).toBe(delivery.backoffMs(failedAttempts));
  }
});
