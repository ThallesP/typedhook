# Publish webhook events

A GitHub Action that publishes your webhook event schemas to the typedhook registry. It loads the module that exports your event map (zod, ArkType or Valibot schemas — anything implementing Standard JSON Schema), turns it into an OpenAPI 3.1 document and pushes it as `owner/name@version`, authenticated with the workflow's GitHub OIDC token. No secrets to configure.

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
          events: src/webhooks/events.ts
          name: billing
          title: Billing
          description: Events sent by the billing service
```

Pin a release tag or a commit SHA; `@v1` above stands for the release you pick.

Pushing the tag `v1.4.0` publishes `acme/billing@1.4.0`, where `acme` is the repository owner. Install dependencies first: the events module is loaded with its imports (zod and your own files), so they have to resolve. TypeScript, extensionless relative imports, ESM and CJS all work.

The events module exports the same map you pass to `@typedhook/sdk`:

```ts
import { z } from "zod";

export const events = {
  "invoice.paid": z.object({ invoiceId: z.string(), amountCents: z.int() }),
};
```

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
          events: src/webhooks/events.ts
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
| `events` | required | Path to the module exporting the event map, relative to `working-directory` |
| `export` | `events` | Name of the export holding the event map |
| `name` | required | Registry name; the owner is always the repository owner, so this publishes to `owner/name` |
| `version` | the tag | Version to publish. On a tag run it defaults to the tag without a leading `v` (`v1.4.0` → `1.4.0`); anywhere else it's required |
| `title` | `name` | OpenAPI `info.title` |
| `description` | | OpenAPI `info.description` |
| `registry-url` | the hosted registry | Registry base URL. The default is `http://localhost:8787` until the hosted registry is deployed |
| `working-directory` | `.` | Directory that `events` and `output-file` are resolved against |
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
