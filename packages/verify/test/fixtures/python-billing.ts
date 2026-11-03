/**
 * Source of python-billing.py. Regenerate it after changing the events or the
 * generator: `bun packages/verify/test/fixtures/python-billing.ts`
 */
import { generateCode } from "../../src/registry/generate";
import { hashDocument } from "../../src/registry/hash";
import { billingDocument } from "./billing";

export async function billingPython(): Promise<string> {
  return generateCode("python", {
    registry: "acme/billing",
    version: "1.0.0",
    hash: await hashDocument(billingDocument),
    document: billingDocument,
  });
}

if (import.meta.main) {
  await Bun.write(new URL("./python-billing.py", import.meta.url), await billingPython());
}
