export const OUTBOX_MAX_ATTEMPTS = 20;

export function outboxBackoffSec(failedAttempts: number) {
  return Math.min(3_600, 30 * 2 ** (failedAttempts - 1));
}
