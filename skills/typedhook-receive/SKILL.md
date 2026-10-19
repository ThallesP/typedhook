---
name: typedhook-receive
description: Receive another product's webhooks with typed payloads and verified signatures, using code generated from the typedhook registry (TypeScript, Python or Go). Use when adding a webhook endpoint for a third-party service, when asked to type incoming webhook payloads or check their signatures, or when the user mentions typedhook add or pull.
---

# Receive webhooks with typedhook

## 1. Find the product

`npx typedhook search <product>` lists matching registries as `owner/name@version`, and `npx typedhook info owner/name` shows the events and versions. The MCP server at `https://registry.typedhook.dev/mcp` answers the same questions (`search_registries`, `get_registry`, `get_event`).

If the product isn't there, typedhook can't help with types: tell the user, and suggest the sender publishes their events (`npx typedhook publish`).

## 2. Add it

Run this in the project that receives the webhooks:

| Project | Command | Writes |
| --- | --- | --- |
| TypeScript / JavaScript | `npx typedhook add owner/name` | `src/webhooks/<name>.ts` |
| Python | `npx typedhook add owner/name --lang python` | `webhooks/<name>.py` |
| Go | `npx typedhook add owner/name --lang go` | `webhooks/<pkg>/<pkg>.go` |

It also writes `typedhook.json` and `typedhook.lock`; commit them with the generated code. In a JS project it adds `typedhook pull` to `postinstall`: also add `typedhook` and `@typedhook/verify` to `dependencies` (not devDependencies). Elsewhere, add `npx typedhook pull --check` to CI. Never edit the generated files; `npx typedhook pull --update` moves to newer versions within the range.

Without Node, `curl -fsSL https://registry.typedhook.dev/registries/owner/name/latest/code/python -o webhooks/name.py` fetches the same file (no lock, so it won't update itself).

## 3. Write the endpoint

The secret comes from the sender's dashboard; read it from the environment. Verify the raw request body: a body that was parsed and re-serialized won't match the signature.

TypeScript, frameworks with fetch `Request`s (Next.js route handlers, Hono, Remix, Workers, Bun, Elysia, SvelteKit):

```ts
import { createBillingWebhooks } from "./webhooks/billing";

const billing = createBillingWebhooks(process.env.ACME_WEBHOOK_SECRET!);

export const POST = billing.handler({
  "invoice.paid": async (payload, { id }) => {
    // payload is typed for invoice.paid; id is the same on every retry
  },
});
```

`handler` answers 400 when verification fails, 204 after the handler runs, and lets a throwing handler fail the request so the sender retries. Events without a handler are acknowledged. If the generated file has no `create<Name>Webhooks` (the product's payloads don't name their event), use `createVerifier(secret).verify<NameEvents>(request)` from `@typedhook/verify` and route yourself.

TypeScript with Express (raw body): `const result = await billing.verifyPayload(req.body, req.headers)` behind `express.raw({ type: "application/json" })`, then narrow on `result.payload.event`.

Python:

```python
from webhooks.billing import WebhookVerificationError, verify

try:
    event = verify(raw_body_bytes, request.headers, os.environ["ACME_WEBHOOK_SECRET"])
except WebhookVerificationError as error:
    return Response(error.reason, status=400)
if event["event"] == "invoice.paid":
    ...  # mypy and pyright narrow the TypedDict here
```

Go:

```go
body, _ := io.ReadAll(r.Body)
event, err := billing.Verify(body, r.Header, os.Getenv("ACME_WEBHOOK_SECRET"))
if err != nil {
	http.Error(w, err.Error(), http.StatusBadRequest) // errors.As finds a *billing.Error with its Reason
	return
}
switch event := event.(type) {
case *billing.InvoicePaid:
	_ = event.Data // typed
case *billing.UnknownEvent:
	// an event added after the code was generated; acknowledge it
}
w.WriteHeader(http.StatusNoContent)
```

When payloads don't name their event there's no `Verify`/`Parse`: call `billing.VerifySignature(body, r.Header, secret)` and decode into the type for the event the request names.

## 4. Before you finish

- Webhooks can arrive more than once and out of order: store the delivery id (`webhook-id` header) and skip ids already handled.
- Answer 2XX quickly; do slow work in a job.
- Test with a payload signed by the sender's test mode, or sign one yourself with the secret (HMAC-SHA256 over `{id}.{timestamp}.{body}`, header `webhook-signature: v1,<base64>`).
