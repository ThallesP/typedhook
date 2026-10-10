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

1. Create the database: `bunx wrangler d1 create typedhook-registry`, and put the
   printed id in `database_id` in `wrangler.jsonc`.
2. Set `vars.REGISTRY_URL` in `wrangler.jsonc` to the registry's public URL, e.g.
   `https://registry.example.com`. It is the audience pushes must mint their OIDC
   token for, so it has to match the URL clients push to. The worker refuses to
   start without it, so a deploy that forgets it fails.
3. Apply the migrations: `bun run db:migrate`.
4. Deploy: `bun run deploy`. It builds `@typedhook/verify` first, since the
   worker bundles its hashing from the built package.
