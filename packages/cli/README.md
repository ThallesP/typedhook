# typedhook

Typed webhook events without installing the sender's SDK. Senders publish their events
to the typedhook registry with the
[publish action](https://github.com/ThallesP/typedhook/tree/main/packages/publish-action);
this CLI pulls them as TypeScript types for
[`@typedhook/verify`](https://www.npmjs.com/package/@typedhook/verify).

```sh
npm install typedhook @typedhook/verify
npx typedhook add acme/billing
```

This writes `typedhook.json`, `typedhook.lock` and `src/webhooks/billing.ts`, and adds
`typedhook pull` to your `postinstall`, so the types are regenerated on every install.
Commit all three so installs work offline, and keep `typedhook` in `dependencies`: the
postinstall needs it at install time, so `npm ci --omit=dev` fails with it in `devDependencies`.

```ts
import { createVerifier } from "@typedhook/verify";
import type { BillingEvents } from "./webhooks/billing";

const verifier = createVerifier(process.env.WEBHOOK_SECRET!);
const result = await verifier.verify<BillingEvents>(req);
if (result.ok && result.payload.event === "invoice.paid") {
  result.payload.data; // typed for invoice.paid
}
```

## Commands

- `typedhook add <owner/name[@range]>...` adds registries and generates their types. With no
  range it pins `^<latest>`.
- `typedhook pull` only fetches what `typedhook.lock` pins, and skips the network when the
  generated files already match it. `--update` moves to the newest versions the ranges in
  `typedhook.json` allow; `--check` fails when generated files are missing or stale (for CI).
- `typedhook push --name <name> --version <semver>` publishes your own events from GitHub
  Actions. It finds the `webhooks.ts` (or `.js`) that exports your `webhooks()` instance in
  `.`, `src`, `lib`, `server` or `utils`, imports it and reads the events off the instance;
  `--webhooks <file>` points it at another file and `--export <name>` picks an instance when the
  file exports several. Most senders use the
  [publish action](https://github.com/ThallesP/typedhook/tree/main/packages/publish-action)
  instead.

`TYPEDHOOK_REGISTRY_URL` overrides the registry URL.
