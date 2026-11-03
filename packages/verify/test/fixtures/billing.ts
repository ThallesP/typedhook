/**
 * Source of billing-events.ts. Regenerate it after changing the events or
 * the generator: `bun packages/verify/test/fixtures/billing.ts`
 */
import { z } from "zod";
import { generateCode } from "../../src/registry/generate";
import { hashDocument } from "../../src/registry/hash";
import { toOpenAPI } from "../../src/registry/openapi";

const Category = z.object({
  name: z.string(),
  get parent() {
    return Category.optional();
  },
});

const PriceTier = z.object({
  upTo: z.int().nullable(),
  unitAmountCents: z.int(),
  get next() {
    return PriceTier.optional();
  },
});

export const billingEvents = {
  "invoice.paid": z.object({
    invoiceId: z.string(),
    amountCents: z.int(),
    paidAt: z.iso.datetime(),
    lines: z.array(z.object({ sku: z.string(), quantity: z.int() })),
  }),
  "invoice.voided": z.object({
    invoiceId: z.string(),
    reason: z.enum(["duplicate", "fraudulent"]).nullable(),
  }),
  "customer.updated": z.object({
    customerId: z.string(),
    email: z.email().optional(),
    metadata: z.record(z.string(), z.string()),
  }),
  "category.created": Category,
  "price.created": z.object({ priceId: z.string(), tiers: PriceTier }),
  "usage.recorded": z.object({
    meter: z.tuple([z.string(), z.number()]),
    readings: z.tuple([z.string()], z.number()),
  }),
};

export const billingDocument = toOpenAPI(billingEvents, { title: "Billing", version: "1.0.0" });

export async function billingTypes(): Promise<string> {
  return generateCode("typescript", {
    registry: "acme/billing",
    version: "1.0.0",
    hash: await hashDocument(billingDocument),
    document: billingDocument,
  });
}

if (import.meta.main) {
  await Bun.write(new URL("./billing-events.ts", import.meta.url), await billingTypes());
}
