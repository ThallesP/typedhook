# @typedhook/registry

The hosted event registry, a Cloudflare Worker on D1. Senders push OpenAPI 3.1
webhook documents from GitHub Actions (authenticated with the job's OIDC token);
consumers resolve them by semver range.

## Local development

```sh
bun run db:migrate:local
bun run dev
```

`bun run dev` serves on http://localhost:8787 and passes `REGISTRY_URL` as that
URL. A plain `wrangler dev` has no `REGISTRY_URL` and fails at startup.

## Deploying

It runs at https://registry.typedhook.dev on the `typedhook-registry` D1 database.
`vars.REGISTRY_URL` in `wrangler.jsonc` is the audience pushes must mint their OIDC
token for, so it has to match the URL clients push to.

1. Apply new migrations: `bun run db:migrate`.
2. Deploy: `bun run deploy`. It builds `@typedhook/verify` first, since the
   worker bundles its hashing from the built package.
