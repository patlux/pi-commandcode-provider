# Release Process

All npm publication uses the tag-triggered GitHub Actions release workflow with npm Trusted Publishing (OIDC), including recovery. Releases are initiated by pushing a version tag. Merging a PR alone does not publish.

```text
Release PR (version + changelog) → green CI → merge into main
→ push vX.Y.Z on the merge commit → release checks → npm → registry smoke → GitHub Release
```

Both stable releases and prereleases must reference commits already in `main`. Never move a release tag to another commit. Version numbers are chosen by maintainers, not generated from commit messages.

## Activation record

The CI release path was activated and successfully tested end to end on **2026-09-26**:

- Infrastructure: [PR #117](https://github.com/patlux/pi-commandcode-provider/pull/117).
- First release PR: [#118](https://github.com/patlux/pi-commandcode-provider/pull/118), merged as `0c04fc7fc8f2cabe94059b303e89779d40802b99` and tagged `v0.7.3-next.0`.
- [Release run 36251868548](https://github.com/patlux/pi-commandcode-provider/actions/runs/36251868548) passed validation, shared checks, packed-package tests, OIDC publication, registry-package tests and GitHub Release creation.
- [npm `0.7.3-next.0`](https://www.npmjs.com/package/pi-commandcode-provider/v/0.7.3-next.0) became `next`; `latest` remained `0.7.2`. Its registry tarball matched the tested artifact's SHA-512, and its SLSA provenance referenced the release workflow, tag and commit.
- The [GitHub prerelease](https://github.com/patlux/pi-commandcode-provider/releases/tag/v0.7.3-next.0) was created automatically; the latest stable GitHub Release remained `v0.7.2`.
- The `npm` environment allowed only `v*` tags, without a required reviewer. The active **Immutable release tags** ruleset blocked `v*` updates and deletion without bypass actors. npm Trusted Publishing allowed direct publication from `release.yml` in environment `npm`, without a stored npm token or manual approval.

This is dated evidence, not a guarantee that remote settings or dist-tags remain unchanged. Do not repeat activation or reuse this version/tag for a new test. Normal releases use the process below. At activation, **co-maintainer invitations/npm ownership and additional npm publishing-access hardening were still pending**; successful CI publication does not grant those permissions or complete those separate tasks.

## One-time activation

The workflow file does not configure npm or GitHub protection settings. The canonical repository has completed the activation test above; use this checklist when auditing or deliberately reconfiguring that setup, not before every release:

1. Merge `.github/workflows/release.yml` and its supporting scripts/tests into `main` after CI passes.
2. Create the GitHub Environment **`npm`**. Allow deployments from **tags matching `v*`**, not arbitrary branches. Do not require approval exclusively from one maintainer: a tag push is the release authorization.
3. Configure the package's npm Trusted Publisher with these exact values:

   | Setting              | Value                      |
   | -------------------- | -------------------------- |
   | Provider             | GitHub Actions             |
   | Organization or user | `patlux`                   |
   | Repository           | `pi-commandcode-provider`  |
   | Workflow filename    | `release.yml` (not a path) |
   | Environment          | `npm`                      |
   | Allowed action       | Direct `npm publish`       |

   Stage-only permission is insufficient: it requires a separate human approval, unlike this automatic workflow. Use npm's supported setup flow with the owner's own authenticated account. Do not add an `NPM_TOKEN` secret or share a maintainer's credentials. See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).

4. Protect `v*` tags against updates and deletion. Review who can create tags, including existing automation collaborators: tag creation grants publication capability. If creation restrictions are used, allow every release maintainer, not only the repository owner.
5. Keep `main` protected by passing CI. If requiring reviews, add all accepted maintainers to `CODEOWNERS` before enabling mandatory code-owner review; currently it names only `@patlux`. The workflow does not change membership, branch protection or npm package owners.
6. Test the complete path with a **new, intentional `next` prerelease**. Confirm npm's version, `next` dist-tag, provenance and the GitHub prerelease. Verify that `latest` stayed unchanged. A dry run cannot prove OIDC authorization works.
7. After successful validation, review npm's publishing access setting: require 2FA and disallow traditional tokens. Trusted Publishing continues to work. Revoke obsolete automation tokens only after identifying them and obtaining authorization.

GitHub collaborators can release through this workflow without personal npm publish rights. npm package-owner access remains separate and is used for package administration, including Trusted Publisher configuration.

These checks prevent accidental releases from the wrong commit; they are not a sandbox against a trusted writer who can modify workflows. Repository, tag and environment permissions remain the trust boundary.

## Prepare a release PR

Confirm the requested version and channel, a clean/current checkout, the canonical repository and the maintainer's own GitHub identity. Record the current npm dist-tags and latest stable GitHub Release so prerelease verification can prove they were preserved:

```sh
git status --short --branch
git remote -v
gh auth status
npm view pi-commandcode-provider dist-tags --json --prefer-online --registry=https://registry.npmjs.org/
gh release view --repo patlux/pi-commandcode-provider --json tagName,url
npm view pi-commandcode-provider@<intended-version> version --json --prefer-online --registry=https://registry.npmjs.org/
git tag --list 'v<intended-version>'
git ls-remote origin refs/tags/v<intended-version>
```

Replace placeholders before running commands. An unused version should return `E404` / `No match found for version` while the package lookup succeeds; authentication, network and other registry errors do not prove that a version is unused. If the version or tag already exists, investigate recovery or choose another authorized version; do not overwrite it. Check for an active release run before starting another release.

Create a release branch according to the applicable contribution/branch rules; ask for a name if those rules require approval rather than inventing one. From that branch, choose a version explicitly:

```sh
# Example stable version; replace with the intended unused version.
npm version 0.7.3 --no-git-tag-version

# Alternatively, an example prerelease:
# npm version 0.8.0-next.1 --no-git-tag-version
```

Do not use both commands for the same release. Update `CHANGELOG.md` with a nonempty dated section such as `## 0.7.3 - YYYY-MM-DD`. Include user-facing changes, related PR/issue links or numbers, and a `Contributors` subsection whenever external contributors reported, implemented or validated included work.

Run the local checks:

```sh
npm test
npm run format:check
npm audit --audit-level=moderate
npm pack --dry-run
# If installed, actionlint validates GitHub Actions YAML and expressions.
actionlint
git diff --check
```

`npm test` includes release-rule tests. Local integration tests can skip unavailable host binaries; release CI sets `PI_LOCAL_REQUIRED=1` and `OMP_COMPAT_REQUIRED=1`, so both real hosts must run successfully.

Review and commit only the intended changes, open a release PR and wait for all required checks on its exact head commit. Address blocking review findings before merging. If a check fails, diagnose it and make any necessary fix separately reviewable; do not weaken assertions or skip required tests. Merge the release PR into `main` **before** tagging. Do not publish from the open PR branch.

## Tag the merged commit

After fetching the merged result, confirm a clean checkout, the intended merge commit, version and changelog. For example:

```sh
git switch main
git pull --ff-only
# Check that this is the intended release commit before continuing.
git status --short --branch
git log -1 --oneline
node -p 'require("./package.json").version'

git tag -a v0.7.3 -m "Release 0.7.3" <verified-merge-commit>
git push origin refs/tags/v0.7.3
```

Replace the example version and commit. Push the single intended tag, not `--tags`. Use the maintainer's own Git credentials: tags created with a workflow's ordinary `GITHUB_TOKEN` do not normally trigger another push workflow.

| Accepted tag    | npm dist-tag | GitHub Release         |
| --------------- | ------------ | ---------------------- |
| `vX.Y.Z`        | `latest`     | Stable/latest          |
| `vX.Y.Z-next.N` | `next`       | Prerelease, not latest |

Only these formats are accepted, without leading zeroes or build metadata. Other `v*` tags start validation but cannot publish. There is no automatic version bump and no `release.published` trigger.

Wait for the release to finish before pushing another tag. The global concurrency group never cancels a running release, but GitHub keeps only one pending run and does not guarantee FIFO order. A newer push can replace a pending run. Review canceled/pending runs rather than assuming every tag was published.

## What the workflow does

1. **Validate:** canonical repository, tag-push event, exact event commit, clean tracked checkout, current remote tag, membership in `main`, package and lockfile versions, dated changelog, expected package/repository identity and no `publishConfig` override.
2. **Check:** call the existing CI workflow for this commit, including tests, formatting, workflow syntax, Pi/OMP compatibility and security jobs. PR-only dependency review runs on the preceding release PR, not again on the tag.
3. **Package:** run the full suite on Node 24 with both hosts required, audit dependencies, then pack once with lifecycle scripts disabled. Check the package file allowlist and run the Pi/OMP mock suites against an isolated installation of that tarball. Upload the tarball, SHA-512 integrity metadata and release notes as one immutable Actions artifact.
4. **Publish:** on a fresh GitHub-hosted runner in environment `npm`, verify the artifact, Git refs and registry state again. Publish that exact tarball through OIDC, without lifecycle scripts or dependency installation from the repository. Only this job has `id-token: write`; there is no npm token secret or release dependency cache. Node 24 and npm 11.20.0 satisfy npm's Trusted Publishing requirements. Provenance is generated automatically.
5. **Verify:** download the exact public-registry tarball, verify its SHA-512 against the tested artifact and verify its dist-tag. Install it in isolation and run both host suites again, without OIDC permissions.
6. **GitHub Release:** only after verification succeeds, create the release from the existing tag using its changelog section, contributors and validation evidence. This separate job has `contents: write`, but no OIDC permission.

The integration suites exercise real Pi and Oh My Pi binaries, but use loopback-only mock APIs and temporary credentials/homes. No paid Command Code account is needed. Live provider testing remains a separate, explicitly authorized check; a green workflow does not claim live API verification.

## Local package smoke test

With real `pi`, `omp` and Bun available, pack to a temporary directory and exercise exactly that package:

```sh
artifact_dir="$(mktemp -d)"
npm pack --ignore-scripts --pack-destination "$artifact_dir"
npm run test:release-package -- "$artifact_dir/pi-commandcode-provider-<version>.tgz"
```

`PI_BIN` and `OMP_BIN` can point to explicit executables. Both are mandatory for the package smoke test. It installs with `--ignore-scripts --omit=peer` outside the checkout, uses clean auth/config homes, loads the installed entrypoint and removes its temporary installation afterward. The outer tarball directory is retained for inspection; remove only the directory you created when finished.

## Verification and recovery

### Monitor the exact release

Use the tag and commit, not just the most recent run, to identify the publication:

```sh
gh run list --repo patlux/pi-commandcode-provider --workflow release.yml --branch v<version> --event push --json databaseId,headSha,status,conclusion,url
gh run watch <run-id> --repo patlux/pi-commandcode-provider --exit-status
gh run view <run-id> --repo patlux/pi-commandcode-provider --json status,conclusion,headSha,jobs,url
npm view pi-commandcode-provider dist-tags --json --prefer-online --registry=https://registry.npmjs.org/
npm view pi-commandcode-provider@<version> version dist.integrity dist.attestations --json --prefer-online --registry=https://registry.npmjs.org/
gh release view v<version> --repo patlux/pi-commandcode-provider --json tagName,isDraft,isPrerelease,url
gh release view --repo patlux/pi-commandcode-provider --json tagName,url
```

A local `gh run watch` timeout does not cancel or fail the remote run. Inspect its current status before deciding on recovery.

### Completion checklist

- The run's `headSha` and the peeled annotated tag match the verified merge commit. All release stages succeeded; PR-only dependency review is intentionally skipped on the tag run and must have passed on the release PR.
- The exact public npm version exists. The intended dist-tag points to it. For a prerelease, compare `latest` and the latest stable GitHub Release against the recorded pre-release values; do not assume a fixed version number for future releases.
- The registry verification job confirmed that the downloaded tarball's SHA-512 matches the artifact tested before publication. Both real Pi and OMP suites passed against an isolated installation of that registry tarball.
- `dist.attestations` contains SLSA provenance. Inspect the public attestation linked there (or npm's provenance view): its package subject/digest, repository, `.github/workflows/release.yml`, tag ref, source commit and run URL must match this release. Presence alone does not prove those values match. CI verifies tarball integrity; this provenance inspection is a separate completion check.
- The GitHub Release exists, is not a draft and has the correct prerelease/stable status. Report the release PR, tag/commit, run, npm and GitHub Release links, channel checks, package-test results and any remaining warnings. Distinguish mock API coverage from live Command Code testing.

### Partial-failure recovery

- **Version temporarily absent after a successful publish:** npm can acknowledge publication before the version/dist-tag is visible everywhere. The first release briefly returned `E404` during propagation. Recheck with `--prefer-online` at bounded intervals (for example, every 10 seconds for up to two minutes); do not republish or change a tag. CI currently performs up to six metadata lookups with five-second waits between unsuccessful lookups. If visibility still fails, inspect the run and registry and report the blocker. Retry failed verification jobs only after confirming the expected version, integrity and dist-tag.
- **Validation or tests fail before publish:** nothing is published. Diagnose the failure. If code must change, make another reviewed commit with a new unused version/tag; do not move the failed tag. A transient infrastructure failure can be retried for the same commit.
- **Publish reports an error:** first check the exact version on npm. A request may have succeeded despite a runner/network error. Do not blindly repeat `npm publish`.
- **Version exists, later steps failed:** after diagnosing the failure and confirming the registry matches, rerun only the failed jobs in the same Actions run (`gh run rerun <run-id> --repo patlux/pi-commandcode-provider --failed`) when release recovery is authorized. The successful package job's artifact ID is reused. Publishing is skipped only if registry integrity and the intended dist-tag match exactly. Then the registry smoke and GitHub Release steps can finish.
- **Rerun all jobs:** a new attempt-specific artifact is produced. npm packing of the same content should be deterministic, but registry integrity must still match; otherwise stop. Host packages are tested at the current `latest`, so a later compatibility regression can require investigation.
- **Artifact expired:** artifacts are retained for 30 days. When recovery is authorized, rerun the original release workflow to rebuild the exact original commit through all checks and compare integrity with any published version. Do not manufacture replacement release metadata. If the rebuilt artifact or registry state does not match, stop with the evidence and blocker.
- **Version differs, registry errors or dist-tag has moved:** fail closed. The workflow does not overwrite versions, repair dist-tags, roll a newer `latest`/`next` backwards or force-update tags. Resolve the discrepancy explicitly.
- **npm succeeds but registry smoke fails:** the version is already public and cannot be rolled back by CI. Investigate before publishing a corrected version or explicitly deprecating the faulty one. The GitHub Release remains uncreated.
- **GitHub Release already exists:** a matching non-draft stable/prerelease is left unchanged. The workflow never silently edits an existing release.

Recovery stays within the CI/OIDC release path. If the workflow or Trusted Publisher configuration needs repair, diagnose it and obtain authorization for the required changes. Until the CI checks and OIDC authorization succeed, stop publication; there is no alternative publishing path.

After both npm and GitHub verification, comment on included PRs/issues if requested. Do not notify unrelated issues or announce a version while registry checks are still failing.
