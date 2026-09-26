---
name: pi-commandcode-release
description: Use when preparing, validating, publishing, or documenting a pi-commandcode-provider release/deployment, including version bumps, changelog entries, npm publish, GitHub releases, tags, and release follow-up comments.
---

# pi-commandcode-provider Release Skill

Read the repository's `CONTRIBUTING.md` and `RELEASE.md` before release work. `RELEASE.md` is the canonical operational guide, including one-time GitHub/npm activation and partial-failure recovery.

## Authorization

Do not commit, push, merge, tag, publish or change remote settings unless explicitly authorized. Preparing a workflow on a local branch does not activate Trusted Publishing, invite maintainers or authorize a test release. A release tag push is a public npm publication request once the workflow is active.

## Release order

1. Confirm Trusted Publishing and the `npm` environment are configured before planning an automated publication. Do not read credential files.
2. Prepare a release PR with an explicit version in `package.json` and `package-lock.json` and a nonempty dated `CHANGELOG.md` section. Include contributors and related PRs/issues.
3. Run the checks from `RELEASE.md`; preserve unrelated changes.
4. Wait for the release PR's CI and merge into `main` before tagging.
5. Verify the exact merged release commit, then create and push one annotated `vX.Y.Z` or `vX.Y.Z-next.N` tag when authorized.
6. Monitor `.github/workflows/release.yml`: validation → shared CI → packed-package test → OIDC npm publish → registry package test → GitHub Release.
7. Verify the exact npm version, dist-tag, integrity, provenance and GitHub Release. Report the run URL and tested commit.
8. Comment only on included PRs/issues after successful verification and when follow-up is authorized.

Stable tags publish to `latest`; `-next.N` tags publish to `next` and create GitHub prereleases. Both must point to commits in `main`. No release is published merely by merging a PR. Never force-move a release tag or publish manually alongside a running release workflow.

## Verification

At minimum:

```sh
npm test
npm run format:check
npm audit --audit-level=moderate
npm pack --dry-run
git diff --check
```

Validate workflow changes with `actionlint`. For a package smoke test, pack to a temporary directory and run `npm run test:release-package -- <tarball>`, with Pi, OMP and Bun available. Both real hosts are required; mocks and isolated homes avoid live credentials. Do not report skipped host tests as passed, or mock testing as live Command Code verification.

Release notes come from the tagged changelog section. Include a Contributors subsection for external reports, implementation and validation; the workflow appends its own validation/run evidence.

## Authentication and recovery

CI uses npm Trusted Publishing bound to the canonical repository, `release.yml` and environment `npm`, with direct `npm publish` permission. Do not add a long-lived npm token. Maintainers do not need personal npm rights to trigger authorized CI releases; package ownership remains separate.

The workflow verifies SHA-512 integrity before reuse of an existing published version. After an ambiguous publish error, check npm before retrying. Prefer rerunning failed jobs in the original run so the already-tested artifact is retained. An integrity mismatch, missing artifact or changed dist-tag requires investigation, not an automatic repair.

Local npm publishing is only an explicitly authorized recovery exception. Read the npm-local-publish and credential-broker skills before accessing credentials. Do not use local publishing as a fallback around failing CI or unconfigured OIDC.
