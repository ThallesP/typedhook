---
name: typedhook-publish
description: Publish the webhook events a product sends to the typedhook registry, so whoever receives them gets typed code (TypeScript, Python, Go) with signature verification instead of reading docs. Use when asked to publish, document or type a product's webhooks or events, to "put our webhooks on typedhook", or to keep the published events in sync from CI.
---

# Publish webhook events to typedhook

The goal is one command, `npx typedhook publish`, that turns the events this codebase sends into a versioned registry entry `owner/name`. Consumers then run `npx typedhook add owner/name`.

## 1. Find what the product sends

Search the code for where webhooks go out: POSTs to subscriber URLs, webhook or event dispatchers, Svix, Hookdeck or `@typedhook/sdk` calls, outbox tables. For every event, write down its name and the exact JSON body sent, envelope included. Note where the shapes are already declared:

- zod, valibot or arktype schemas (the map passed to `@typedhook/sdk`'s `webhooks({ events })`)
- an OpenAPI 3.1 document with a `webhooks:` section
- JSON Schemas, TypeScript types, Pydantic models, Go structs
- test fixtures or logged payloads

## 2. Pick the source

Use the first row that fits:

| The repo has | Flag |
| --- | --- |
| A TS/JS module exporting `{ "invoice.paid": z.object(...) }` | `--events src/webhooks/events.ts` (plus `--export name` if it isn't `events`) |
| OpenAPI 3.1 with `webhooks:` | `--openapi openapi.yaml` |
| Shapes declared anywhere else | write JSON Schemas, one per event, then `--schemas typedhook/events` |
| Only real payloads | `--examples fixtures/webhooks` (a file per event, or a folder of samples per event); the schema is inferred |

`--events` imports the module, so dependencies must be installed and importing it must not need secrets or a database. If it does, use `--schemas` instead.

Writing JSON Schemas (`typedhook/events/<event name>.json`, file name = event name):

- Draft 2020-12, describing the whole request body as sent.
- Pin the field that names the event with `const`, like `"type": { "const": "invoice.paid" }`. Consumers then get a discriminated union and a typed router.
- `required` lists what is always sent. Nullable is `"type": ["string", "null"]`.
- Put a `description` on each event and on fields whose meaning isn't obvious; they show up in the generated code.
- Add one realistic payload under `examples`.
- Shared shapes go in `$defs` inside the file. References to other files aren't supported.
- Generate the schemas from the source of truth when you can (`z.toJSONSchema`, Pydantic's `TypeAdapter(Model).json_schema()`) instead of writing them by hand.

## 3. Sign in and dry run

1. `npx typedhook login` prints a URL and a code. Ask the user to open the URL and enter the code, then wait for the command to finish. Don't try to approve it yourself.
2. `npx typedhook publish <source flag> --name <product> --dry-run`. Check the event count and names in the output.
3. To publish under a GitHub organization the user belongs to, add `--owner <org>`. The default is the user's own login.

## 4. Publish

Run the same command without `--dry-run`. The first version is 1.0.0. The flags are saved to `typedhook.json`, so from then on it's just `npx typedhook publish`, and the version is picked from what changed: a removed event or field, or one that became optional, is major; additions are minor; descriptions and examples are a patch. Passing a `--version` lower than the changes need fails and lists the breaking changes.

Commit `typedhook.json` and any schema files you wrote.

## 5. Keep it published from CI

GitHub Actions needs no secret, it uses the job's OIDC token:

```yaml
name: Publish webhook events
on:
  push:
    branches: [main]
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
      - run: npm ci # only needed for --events
      - run: npx typedhook@latest publish
```

Unchanged events publish nothing, so running it on every push is fine. Other CI systems set `TYPEDHOOK_TOKEN`.

## Report back

Tell the user the registry page URL and the consumer command (both printed by `publish`), and say which events or fields you inferred instead of reading them from code.
