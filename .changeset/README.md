# Changesets

Run `bun changeset` in a PR that changes a published package, pick the bump and write one line for the changelog. All `@typedhook/*` packages and the `typedhook` CLI share one version.

Merging to main opens or updates the "Version packages" PR. Merging that PR publishes to npm.
