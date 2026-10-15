# Publish webhook events

A GitHub Action that publishes your webhook event schemas to the typedhook registry. It finds the file that exports your `webhooks()` instance, reads its events (zod, ArkType or Valibot schemas — anything implementing Standard JSON Schema), turns them into an OpenAPI 3.1 document and pushes it as `owner/name@version`, authenticated with the workflow's GitHub OIDC token. No secrets to configure.

Consumers then pull typed events with:

```sh
npx typedhook add acme/billing@^1.4.0
```

## Usage

```yaml
name: Publish webhook events

on:
  push:
    tags: ["v*"]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - run: npm ci
      - uses: ThallesP/typedhook/packages/publish-action@v1
        with:
          name: billing
          title: Billing
          description: Events sent by the billing service
```

Pin a release tag or a commit SHA; `@v1` above stands for the release you pick.

Pushing the tag `v1.4.0` publishes `acme/billing@1.4.0`, where `acme` is the repository owner.

The action looks for `webhooks.ts` (or `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`) in the working directory, then in `src`, `lib`, `src/lib`, `server`, `src/server`, `utils` and `src/utils`, and takes the first one it finds. That file exports the instance you call `send()` on, under any name or as the default:

```ts
// src/lib/webhooks.ts
import { webhooks } from "@typedhook/sdk";
import { z } from "zod";

export const wh = webhooks({
  events: {
    "invoice.paid": z.object({ invoiceId: z.string(), amountCents: z.int() }),
  },
  subscribers: async ({ event, subject }) => db.findSubscribers(event, subject),
});
```

Set `webhooks` to point at another file, and `export` when the file exports more than one instance.

The file is imported the way your app imports it, with everything it imports (zod, your database client, your own files). Install dependencies first so they resolve. TypeScript, extensionless relative imports, ESM and CJS all work, but TypeScript path aliases like `@/db` don't yet. Anything the file does when it's imported runs in the job too, so code that reads a required environment variable or connects to a database at import time fails there.

### Validate in pull requests

`dry-run` builds and validates the document without uploading it, and `output-file` writes it out, so a PR build can check that the schemas convert and keep the document as an artifact:

```yaml
on: pull_request

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - run: npm ci
      - uses: ThallesP/typedhook/packages/publish-action@v1
        with:
          name: billing
          version: 0.0.0
          dry-run: true
          output-file: openapi.json
      - uses: actions/upload-artifact@v4
        with:
          name: openapi
          path: openapi.json
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `webhooks` | the first `webhooks.ts` found | Path to the module exporting your `webhooks()` instance, relative to `working-directory` |
| `export` | | Name of the export holding the instance, when the module exports several |
| `name` | required | Registry name; the owner is always the repository owner, so this publishes to `owner/name` |
| `version` | the tag | Version to publish. On a tag run it defaults to the tag without a leading `v` (`v1.4.0` → `1.4.0`); anywhere else it's required |
| `title` | `name` | OpenAPI `info.title` |
| `description` | | OpenAPI `info.description` |
| `registry-url` | the hosted registry | Registry base URL. The default is `https://registry.typedhook.dev` |
| `working-directory` | `.` | Directory that `webhooks` and `output-file` are resolved against, and that's searched for a webhooks file |
| `dry-run` | `false` | Build and validate the document without uploading it |
| `output-file` | | Also write the document (pretty JSON) to this path |

## Outputs

| Output | Description |
| --- | --- |
| `registry` | `owner/name` |
| `version` | The version published |
| `hash` | `sha256-<base64>` over the canonical JSON of the document |
| `status` | `created`, `unchanged` (this exact document was already published under this version) or `dry-run` |

The run also writes a job summary with the status, hash and the `npx typedhook add` command for consumers.

## Security

- Only the repository owner can publish under its name: the registry takes the owner from the OIDC token's `repository_owner` claim, never from the request.
- Tokens from `pull_request` and `pull_request_target` runs are rejected, since those can run code from whoever opened the PR. Use `dry-run` there.
- The first push binds `owner/name` to the owner's numeric GitHub id, so a renamed account's login can't be taken over to publish under the old name.
- Versions are immutable: pushing different content to an existing version fails; pushing the same content again returns `unchanged`.

## Development

`dist/` is committed because Actions run straight from the repository. After changing `src/` (or `@typedhook/verify`, which gets bundled in), rebuild it:

```sh
bun run --cwd packages/verify build
bun run --cwd packages/publish-action build
```
