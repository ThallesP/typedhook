import { z } from "zod";
import { webhooks } from "@typedhook/sdk";
import { money } from "./shared";

export const wh = webhooks({
  events: {
    "invoice.paid": z.object({ invoiceId: z.string(), total: money, paidAt: z.iso.datetime() }),
    "invoice.voided": z.object({ invoiceId: z.string(), reason: z.enum(["duplicate", "fraudulent"]) }),
  },
  subscribers: [],
});
