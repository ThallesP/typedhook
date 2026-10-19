/**
 * Source of go/billing/billing.go. Regenerate it after changing the events or
 * the generator: `bun packages/verify/test/fixtures/go-billing.ts`
 */
import { generateCode } from "../../src/registry/generate";
import { hashDocument } from "../../src/registry/hash";
import { billingDocument } from "./billing";

export async function billingGo(): Promise<string> {
  return generateCode("go", {
    registry: "acme/billing",
    version: "1.0.0",
    hash: await hashDocument(billingDocument),
    document: billingDocument,
  });
}

if (import.meta.main) {
  await Bun.write(new URL("./go/billing/billing.go", import.meta.url), await billingGo());
}
