/**
 * Compile-time contract for generated registry types. Checked by
 * `tsc --noEmit`, never executed. The load-bearing claim: verify<Events>()
 * narrows `data` by `event`.
 */
import { createVerifier } from "../src/index";
import type { BillingEvent, BillingEvents } from "./fixtures/billing-events";

export async function verifyNarrowsDataByEvent(request: Request) {
  const result = await createVerifier("s").verify<BillingEvents>(request);
  if (!result.ok) return;
  const { payload } = result;

  if (payload.event === "invoice.paid") {
    const invoiceId: string = payload.data.invoiceId;
    const quantity: number = payload.data.lines[0]?.quantity ?? 0;
    // @ts-expect-error customer.updated fields don't exist under invoice.paid
    payload.data.customerId;
    return [invoiceId, quantity];
  }
  if (payload.event === "invoice.voided") {
    const reason: "duplicate" | "fraudulent" | null = payload.data.reason;
    return reason;
  }
  if (payload.event === "category.created") {
    // Recursive schemas keep their recursion.
    const grandparent: string | undefined = payload.data.parent?.parent?.name;
    return grandparent;
  }

  const subject: string | null = payload.subject;
  // @ts-expect-error not an event in the registry
  if (payload.event === "invoice.refunded") return subject;
  return subject;
}

export function eventHelperPicksOneEvent(paid: BillingEvent<"invoice.paid">) {
  const at: string = paid.data.paidAt;
  // @ts-expect-error the helper only accepts event names in the registry
  type Missing = BillingEvent<"invoice.refunded">;
  return at;
}

export function emailIsOptional(updated: BillingEvent<"customer.updated">) {
  // @ts-expect-error email is optional, so it may be undefined
  const email: string = updated.data.email;
  return email;
}
