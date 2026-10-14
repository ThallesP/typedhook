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
can be typed without installing anything from them. The
[`typedhook`](https://www.npmjs.com/package/typedhook) CLI pulls their events as types for
`verifier.verify<Events>()`:

```sh
npm install typedhook
npx typedhook add acme/billing
```

See the [CLI README](https://github.com/ThallesP/typedhook/tree/main/packages/cli).

Full docs: https://github.com/ThallesP/typedhook
