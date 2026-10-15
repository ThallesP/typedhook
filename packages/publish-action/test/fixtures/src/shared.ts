import { z } from "zod";

export const money = z.object({ amountCents: z.int(), currency: z.string().length(3) });
