---
name: pi-commandcode-release
description: Prepare, verify, document, or recover pi-commandcode-provider releases through tag-triggered GitHub Actions and npm Trusted Publishing. Use for release PRs, version bumps, changelogs, stable/next tags, provenance checks, GitHub releases, and release follow-up comments.
---

# pi-commandcode-provider Release Skill

Resolve repository paths from this skill directory: the repository root is `../../..`. Read [AGENTS.md](../../../AGENTS.md), [CONTRIBUTING.md](../../../CONTRIBUTING.md) and [RELEASE.md](../../../RELEASE.md) before release work. `RELEASE.md` is the canonical operational guide; keep detailed commands and recovery procedures there rather than maintaining a second runbook here.

## Established release path

This repository publishes **exclusively through tag-triggered GitHub Actions and npm Trusted Publishing (OIDC)**, including recovery. This project-specific policy governs every release; there is no alternative publishing path. The workflow authenticates through OIDC without a stored npm token.

Activation was verified on **2026-09-26** with `0.7.3-next.0`: [PR #118](https://github.com/patlux/pi-commandcode-provider/pull/118), commit `0c04fc7fc8f2cabe94059b303e89779d40802b99`, [successful release run](https://github.com/patlux/pi-commandcode-provider/actions/runs/36251868548) and [GitHub prerelease](https://github.com/patlux/pi-commandcode-provider/releases/tag/v0.7.3-next.0). npm `next` became `0.7.3-next.0`; `latest` stayed `0.7.2`. Registry integrity, Pi/OMP package tests and provenance were verified.

Treat this as historical evidence, not current registry/configuration state. Do not repeat setup or reuse that version/tag. Maintainer invitations, npm ownership and additional npm publishing-access hardening were still pending at activation and require separate authorization.

## Authorization

Do not commit, push, merge, tag, publish or change remote settings unless explicitly authorized. A documentation/skill update does not authorize another release, settings changes or maintainer invitations. Confirm the intended version and channel before publication; a `next` prerelease is a real public release, not a dry run. A release tag push initiates npm publication through the active workflow. Follow applicable branch-naming rules and ask when a name needs approval.

## Release order

1. Confirm a clean/current checkout, canonical repository and the maintainer's own GitHub identity. Use the established configuration; if it has changed or access fails, inspect through the documented service route without reading credential files or silently reconfiguring anything. Check that no other release is active.
2. Record current npm dist-tags and the latest stable GitHub Release. Confirm the intended version and local/remote tag are unused. A version-specific `E404` is evidence of absence only when the package lookup succeeds; auth/network failures are blockers, not permission to publish.
3. Prepare a release PR with an explicit version in `package.json` and `package-lock.json` (`npm version <version> --no-git-tag-version`) and a nonempty dated `CHANGELOG.md` section. Include contributors and related PRs/issues. Preserve unrelated changes.
4. Run the checks from `RELEASE.md`, inspect the diff and open the authorized PR. Wait for CI on its exact head, address blocking review findings and merge into `main` before tagging. Keep any necessary test fixes separately reviewable; never weaken acceptance checks.
5. Verify the exact merged release commit, version, changelog and clean checkout, then create and push only its single annotated `vX.Y.Z` or `vX.Y.Z-next.N` tag when authorized. Do not assume a newer `main` HEAD is the intended merge commit.
6. Identify the tag-push run by tag and commit. Monitor `.github/workflows/release.yml`: validation → shared CI → packed-package test → OIDC npm publish → registry package test → GitHub Release. A local watch timeout does not mean the remote run failed.
7. Apply the completion checklist below and report the evidence. Do not call a green publish job alone a completed release.
8. Comment only on included PRs/issues after successful verification and when follow-up is authorized.

Stable tags publish to `latest`; `-next.N` tags publish to `next` and create GitHub prereleases. Both must point to commits in `main`. No release is published merely by merging a PR. Never force-move a release tag. Publication and recovery must use the release workflow.

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

## Completion evidence

Use the commands in [RELEASE.md](../../../RELEASE.md#verification-and-recovery). Confirm and report:

- The release PR, merged commit, annotated tag and successful run URL all identify the intended release.
- The exact npm version and intended dist-tag match. For a prerelease, npm `latest` and the latest stable GitHub Release remain at the values recorded before release, not a hard-coded historical version.
- The registry tarball matches the tested artifact's SHA-512, and both Pi and OMP passed against an isolated installation of that downloaded package.
- The public SLSA provenance matches the package/digest, repository, workflow path, tag, source commit and run. `dist.attestations` being present alone is not enough; inspect its linked statement. CI's checksum check and this provenance inspection are distinct.
- The GitHub Release exists, is not a draft and has the intended stable/prerelease status. Include npm and release links and any remaining warnings/blockers. State that host tests used mock APIs unless separately authorized live tests actually ran.

## Authentication and recovery

CI uses npm Trusted Publishing bound to `patlux/pi-commandcode-provider`, `release.yml` and environment `npm`, with direct `npm publish` permission. The environment allows only `v*` tags without required approval; version tags are protected against updates/deletion. Do not add a long-lived npm token or change those settings as a workaround. Maintainers with the necessary repository/tag permissions do not need personal npm rights for CI publication; package administration remains separate.

After an ambiguous publish error, check npm before retrying. A successful publish can precede registry visibility: the first release briefly returned `E404`. Use bounded, fresh lookups with `--prefer-online` as documented in `RELEASE.md`; do not infer failure from the first lookup or blindly republish.

After diagnosing a post-publish failure and confirming the expected version, integrity and dist-tag, prefer rerunning only failed jobs in the original Actions run when recovery is authorized. This retains the already-tested artifact. Never move the tag, roll back a dist-tag, create replacement artifact metadata or bypass CI/OIDC to make a release succeed. An integrity mismatch, missing artifact, changed dist-tag or persistent registry failure requires stopping with the run/version evidence, attempted checks, blocker and next input needed.

If the workflow or Trusted Publisher configuration needs repair, diagnose the failure and obtain authorization for the required changes. Until CI checks and OIDC authorization succeed, stop publication. Use the original workflow's checked rebuild path for expired artifacts as documented in `RELEASE.md`.
