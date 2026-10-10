# @typedhook/verify

Zero-dependency webhook signature verification. WebCrypto only — Node 20+, Bun,
Deno, Cloudflare Workers, edge. Verifies [Standard Webhooks](https://www.standardwebhooks.com/)
signatures (`svix-*` headers accepted too), so it works with svix-style senders as
well as [`@typedhook/sdk`](https://www.npmjs.com/package/@typedhook/sdk).

```ts
import { createVerifier } from "@typedhook/verify";

const verifier = createVerifier(process.env.WEBHOOK_SECRET!);

// fetch-style frameworks (Next.js, Hono, Remix, Workers)
export async function POST(req: Request) {
  const result = await verifier.verify(req);
  if (!result.ok) return new Response(result.reason, { status: 400 });
  result.payload; // parsed JSON body
  return new Response(null, { status: 204 });
}

// express / fastify — pass the RAW body
const result = await verifier.verifyPayload(req.body, req.headers);
```

Failures are reason codes, never exceptions. Signatures are checked over the raw
bytes received. Delivery is at-least-once — dedupe on `result.id` (stable across
retries).

## Typed events from the registry

Senders that publish their events with the
[publish action](https://github.com/ThallesP/typedhook/tree/main/packages/publish-action)
can be typed without installing anything from them. With this package installed:

```sh
npx typedhook add acme/billing
```

This writes `typedhook.json`, `typedhook.lock` and `src/webhooks/billing.ts`, and adds
`typedhook pull` to your `postinstall`, so the types are regenerated on every install.
Commit all three so installs work offline, and keep `@typedhook/verify` in `dependencies`:
the postinstall needs it at install time, so `npm ci --omit=dev` fails with it in `devDependencies`.

```ts
import type { BillingEvents } from "./webhooks/billing";

const result = await verifier.verify<BillingEvents>(req);
if (result.ok && result.payload.event === "invoice.paid") {
  result.payload.data; // typed for invoice.paid
}
```

- `typedhook pull` only fetches what `typedhook.lock` pins, and skips the network when the
  generated files already match it.
- `typedhook pull --update` moves to the newest versions allowed by the ranges in `typedhook.json`.
- `typedhook pull --check` fails when generated files are missing or stale (for CI).

Full docs: https://github.com/ThallesP/typedhook
