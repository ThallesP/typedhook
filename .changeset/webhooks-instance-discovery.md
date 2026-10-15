---
"typedhook": minor
"@typedhook/sdk": minor
---

`typedhook push` and the publish action now read your events off the `webhooks()` instance, Better Auth style: they find `webhooks.ts` in `.`, `src`, `lib`, `server` or `utils`, import it and take the instance it exports. `--events` and the action's `events` input are replaced by an optional `--webhooks <file>` / `webhooks` input, and `--export` / `export` now only picks between several instances. The CLI loads the file with jiti, so TypeScript works on Node 20 too. `webhooks()` instances carry a `~typedhook` property with their events.
