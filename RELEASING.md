# Releasing OAI Bot

OAI Bot uses Semantic Versioning and Release Please. There is no manual version-editing ritual and no npm publication step.

1. Pull requests are squash-merged into `main` with a conventional title such as `feat: add room export` or `fix: recover a stalled handoff`.
2. Release Please maintains a release pull request containing the next version and `CHANGELOG.md` updates.
3. Merging that pull request creates the `vX.Y.Z` tag and GitHub release.
4. The release workflow checks the tagged code and attaches prebuilt `.zip` and `.tar.gz` source bundles to that release.

Do not create version tags by hand unless repairing the automation. A release should pass `npm run check` on all supported operating systems before it is published.
