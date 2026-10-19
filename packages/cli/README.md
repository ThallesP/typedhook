# typedhook

The CLI for the [typedhook registry](https://registry.typedhook.dev): publish the webhook events your product sends, and pull typed code for the ones you receive, in TypeScript, Python or Go.

## Publish

```sh
npx typedhook login
npx typedhook publish --events src/webhooks/events.ts
```

The events can come from a module exporting zod, valibot or arktype schemas (`--events`, `--export` names the export), an OpenAPI 3.1 document with webhooks (`--openapi`), a folder with one JSON Schema per event (`--schemas`), or a folder of example payloads (`--examples`). `.ts` modules load on Node 20 too.

The version is picked from what changed since the latest one: removed events or fields, fields that became optional and changed types are major, additions are minor, descriptions and examples are a patch. `--version` publishes a given version, and fails when it's lower than the changes need. `--dry-run` shows what would be published.

It publishes as you; `--owner` picks a GitHub organization you belong to. The flags are saved in `typedhook.json`, so later it's just `npx typedhook publish`. In GitHub Actions it uses the job's OIDC token (grant `permissions: id-token: write`), with nothing to configure or rotate.

Elsewhere, `TYPEDHOOK_TOKEN` takes the token `typedhook login` saved in `~/.config/typedhook/credentials.json`. It's that person's token: it stops working 90 days after the login, it only publishes for an organization within 7 days of the login (that's when org membership was last checked), and their next `typedhook login` revokes it. That suits a script you run yourself; for CI, prefer GitHub Actions.

## Receive

```sh
npm install typedhook @typedhook/verify
npx typedhook add acme/billing
```

This writes `typedhook.json`, `typedhook.lock` and `src/webhooks/billing.ts`, and adds `typedhook pull` to your `postinstall`, so the code is regenerated on every install. Commit all three so installs work offline, and keep `typedhook` in `dependencies`: the postinstall needs it at install time, so `npm ci --omit=dev` fails with it in `devDependencies`.

```ts
import { createBillingWebhooks } from "./webhooks/billing";

const billing = createBillingWebhooks(process.env.WEBHOOK_SECRET!);

export const POST = billing.handler({
  "invoice.paid": async (payload) => {
    payload.data; // typed for invoice.paid
  },
});
```

`--lang python` and `--lang go` generate a module or package instead; run `typedhook pull --check` in their CI.

## Commands

- `login`, `logout`, `whoami`: sign in with GitHub's device flow; the token is saved in `~/.config/typedhook`.
- `publish`: see above.
- `search [query]`, `info <owner/name>`: what's on the registry, a registry's events and versions.
- `add <owner/name[@range]>...`: adds registries and generates their code. With no range it pins `^<latest>`.
- `pull`: only fetches what `typedhook.lock` pins, and skips the network when the generated files already match it. `--update` moves to the newest versions the ranges allow; `--check` fails when generated files are missing or stale.
- `sdk <owner/name> --lang <lang> --out <dir>`: a package to publish under your own name.

`TYPEDHOOK_REGISTRY_URL` overrides the registry URL.
