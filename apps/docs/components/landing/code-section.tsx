import { highlight } from "fumadocs-core/highlight";
import { CodeBlockTab } from "fumadocs-ui/components/codeblock";
import { CodeBlock } from "@/components/code-block/code-block";
import { CodeTabs, CodeTabsList, CodeTabsTrigger } from "@/components/code-block/code-tabs";
import { codeTheme } from "@/lib/code-theme";
import { FeatureGrid } from "./feature-grid";

const snippets = [
  {
    file: "send.ts",
    code: `import { webhooks } from "@typedhook/sdk";
import { z } from "zod";

export const wh = webhooks({
  events: {
    "invoice.paid": z.object({ invoiceId: z.string(), amountCents: z.number() }),
  },
  subscribers: async ({ event, subject }) => db.findSubscribers(event, subject),
  signing: { secret: process.env.WEBHOOK_SECRET! },
});

const result = await wh.send({
  event: "invoice.paid",
  subject: "acct_42",
  data: { invoiceId: "inv_1", amountCents: 4200 },
});
if (!result.ok) console.error(result.error); // never throws`,
  },
  {
    file: "outbox.ts",
    code: `import { webhooks, outbox } from "@typedhook/sdk";
import { prismaOutboxAdapter } from "@typedhook/prisma";

const wh = webhooks({
  events,
  subscribers,
  signing: { secret: process.env.WEBHOOK_SECRET! },
  delivery: outbox(prismaOutboxAdapter<Prisma.TransactionClient>(prisma)),
});

await prisma.$transaction(async (tx) => {
  const invoice = await tx.invoice.create({ data });
  await wh.with(tx).send({ event: "invoice.paid", subject: invoice.accountId, data });
}); // rolled back? the webhook never existed

wh.worker().start(); // or wh.worker().tick() from a cron`,
  },
  {
    file: "receive.ts",
    code: `import { createVerifier } from "@typedhook/verify";
import type { Events } from "@acme/sdk"; // the sender's exported EventUnion

const verifier = createVerifier(process.env.WEBHOOK_SECRET!);

export async function POST(req: Request) {
  const result = await verifier.verify<Events>(req);
  if (!result.ok) return new Response(result.reason, { status: 400 });

  if (result.payload.event === "invoice.paid") {
    result.payload.data.amountCents; // number
  }
  return new Response(null, { status: 204 });
}`,
  },
];

export async function CodeSection() {
  const highlighted = await Promise.all(
    snippets.map(({ code }) =>
      highlight(code, {
        lang: "ts",
        themes: { light: codeTheme, dark: codeTheme },
        components: { pre: CodeBlock },
      }),
    ),
  );

  return (
    <section className="border-b border-line px-4 py-16 md:px-14 md:py-24">
      <div className="mx-auto max-w-[640px] text-center">
        <h2 className="font-display text-[28px] font-medium leading-[1.1] tracking-[-0.05em] text-[#F4F4F5] [font-stretch:87.5%] md:text-[40px]">
          A few lines <span className="text-mute">on each side</span>
        </h2>
        <p className="mt-3.5 text-[15px] text-mute md:text-[16.5px]">
          Declare events once. Send them signed, right away or after your transaction commits. Verify them with the
          types attached.
        </p>
      </div>
      <div className="mx-auto mt-11 max-w-[880px]">
        <CodeTabs defaultValue={snippets[0].file}>
          <CodeTabsList>
            {snippets.map(({ file }) => (
              <CodeTabsTrigger key={file} value={file}>
                {file}
              </CodeTabsTrigger>
            ))}
          </CodeTabsList>
          {snippets.map(({ file }, index) => (
            <CodeBlockTab key={file} value={file}>
              {highlighted[index]}
            </CodeBlockTab>
          ))}
        </CodeTabs>
      </div>
      <FeatureGrid />
    </section>
  );
}
