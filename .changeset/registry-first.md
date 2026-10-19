---
"typedhook": minor
"@typedhook/verify": minor
---

The registry is now the main way to share webhook events.

- `typedhook login` signs in with GitHub's device flow, so `typedhook publish` works from a laptop, an agent or any CI, not only GitHub Actions.
- `typedhook publish` (formerly `push`) publishes from a zod/valibot/arktype module (`--events`), an OpenAPI 3.1 document (`--openapi`), a folder of JSON Schemas (`--schemas`) or example payloads (`--examples`), picks the version from what changed since the latest one, and saves its flags to `typedhook.json`.
- `typedhook add --lang python|go` generates Python and Go code; `typedhook search`, `info` and `sdk` (a package to publish under your own name) are new.
- Generated TypeScript is keyed by event in a `<Name>EventMap` and, when payloads name their event, comes with `create<Name>Webhooks(secret)`, built on the new `createWebhooks` in `@typedhook/verify`, whose `handler()` verifies and routes requests. Payloads that aren't the `@typedhook/sdk` envelope are supported.

Breaking, for callers of `@typedhook/verify/registry`: `generateTypes(input)` is now `generateCode("typescript", input)` and `GenerateTypesInput` is `GenerateInput`; the CLI's `push` command is `publish`, with `--events` loaded through jiti. Files written by generator v2 are regenerated on the next `typedhook pull`.
