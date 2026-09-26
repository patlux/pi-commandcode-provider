# Release Process

Releases are initiated by pushing a version tag. Merging a PR alone does not publish.

```text
Release PR (version + changelog) → green CI → merge into main
→ push vX.Y.Z on the merge commit → release checks → npm → registry smoke → GitHub Release
```

Both stable releases and prereleases must reference commits already in `main`. Never move a release tag to another commit. Version numbers are chosen by maintainers, not generated from commit messages.

## One-time activation

The workflow file does not configure npm or GitHub protection settings. An owner must complete these steps before the first release:

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

GitHub collaborators can release through this workflow without personal npm publish rights. npm package-owner access remains separate and is useful for package administration and authorized manual recovery.

These checks prevent accidental releases from the wrong commit; they are not a sandbox against a trusted writer who can modify workflows. Repository, tag and environment permissions remain the trust boundary.

## Prepare a release PR

Create a release branch according to the project's contribution rules. From that branch, choose a version explicitly:

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

Review and commit only the release files, open a release PR and wait for CI. Merge it into `main` **before** tagging. Do not publish from the open PR branch.

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

Inspect the release workflow and registry:

```sh
gh run list --workflow release.yml
npm view pi-commandcode-provider version dist-tags --json
npm view pi-commandcode-provider@<version> version dist.integrity dist.attestations --json
gh release view v<version>
```

- **Validation or tests fail before publish:** nothing is published. Diagnose the failure. If code must change, make another reviewed commit with a new unused version/tag; do not move the failed tag. A transient infrastructure failure can be retried for the same commit.
- **Publish reports an error:** first check the exact version on npm. A request may have succeeded despite a runner/network error. Do not blindly repeat `npm publish`.
- **Version exists, later steps failed:** rerun the failed jobs in the same Actions run. The successful package job's artifact ID is reused. Publishing is skipped only if registry integrity and the intended dist-tag match exactly. Then the registry smoke and GitHub Release steps can finish.
- **Rerun all jobs:** a new attempt-specific artifact is produced. npm packing of the same content should be deterministic, but registry integrity must still match; otherwise stop. Host packages are tested at the current `latest`, so a later compatibility regression can require investigation.
- **Artifact expired:** artifacts are retained for 30 days. Do not manufacture replacement release metadata; rebuild the exact original commit through the checks and compare integrity, or perform explicitly authorized manual recovery.
- **Version differs, registry errors or dist-tag has moved:** fail closed. The workflow does not overwrite versions, repair dist-tags, roll a newer `latest`/`next` backwards or force-update tags. Resolve the discrepancy explicitly.
- **npm succeeds but registry smoke fails:** the version is already public and cannot be rolled back by CI. Investigate before publishing a corrected version or explicitly deprecating the faulty one. The GitHub Release remains uncreated.
- **GitHub Release already exists:** a matching non-draft stable/prerelease is left unchanged. The workflow never silently edits an existing release.

Do not run local `npm publish` in parallel with CI. Manual publication is an exceptional, explicitly authorized recovery path, using a maintainer's own npm account and 2FA, never copied credentials or an added CI token.

After both npm and GitHub verification, comment on included PRs/issues if requested. Do not notify unrelated issues or announce a version while registry checks are still failing.
