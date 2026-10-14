# typedhook

## 0.2.1

### Patch Changes

- [#16](https://github.com/ThallesP/typedhook/pull/16) [`fbe2607`](https://github.com/ThallesP/typedhook/commit/fbe2607aa0c456a1f3e6a3ff520345320abf2156) Thanks [@ThallesP](https://github.com/ThallesP)! - Publish from GitHub Actions with npm trusted publishing, so every package now ships with a provenance attestation linking it to the commit and workflow that built it. No code changes.
- Updated dependencies [[`fbe2607`](https://github.com/ThallesP/typedhook/commit/fbe2607aa0c456a1f3e6a3ff520345320abf2156)]:
  - @typedhook/verify@0.2.1

## 0.2.0

### Minor Changes

- [#13](https://github.com/ThallesP/typedhook/pull/13) [`93c2f49`](https://github.com/ThallesP/typedhook/commit/93c2f498812c909a8bd76710f952e5eaaa4d9f04) Thanks [@ThallesP](https://github.com/ThallesP)! - Add the typed event registry. The new `typedhook` CLI (`typedhook add`, `pull`, `push`) pulls a sender's published events as TypeScript types for `verifier.verify<Events>()`, and `@typedhook/verify/registry` exports the OpenAPI generation, type generation and registry client it uses.

### Patch Changes

- Updated dependencies [[`93c2f49`](https://github.com/ThallesP/typedhook/commit/93c2f498812c909a8bd76710f952e5eaaa4d9f04)]:
  - @typedhook/verify@0.2.0
