---
name: pi-commandcode-release
description: Use when preparing, validating, publishing, or documenting a pi-commandcode-provider release/deployment, including version bumps, changelog entries, npm publish, GitHub releases, tags, and release follow-up comments.
---

# pi-commandcode-provider Release Skill

Use this skill for every `pi-commandcode-provider` release.

## Core rule

Keep release work explicit and auditable. Do not publish, tag, push, or merge unless the user explicitly asks in the current conversation.

## Required release order

Preferred order for stable releases:

1. Create a release branch with the version/changelog changes.
2. Open a release PR.
3. Wait for CI to pass.
4. Create a local annotated git tag for the release commit while the PR is still open.
5. Publish the npm package from the release branch/commit.
6. Create the GitHub Release from the release tag.
7. Verify npm and the GitHub Release.
8. Merge the release PR into `main`.
9. Move/recreate the git tag on the merge commit if the project requires tags to point at `main`, then force-update only after explicit user approval. Prefer documenting the tag target instead of force-updating.
10. Comment on included PRs/issues after the package and GitHub Release are live.

If branch protection or repository policy requires tags to point at `main`, ask before changing the order or force-updating a tag.

## Version and changelog

- Increase semver appropriately; for a patch release use `npm version patch --no-git-tag-version`.
- Update `CHANGELOG.md` in the same PR.
- Add a dated section for the new version.
- Include user-facing changes and dependency/security fixes.
- Include a `Contributors` subsection for every release that had external reports, PRs, testing, or issue validation.

Example changelog structure:

```md
## 0.4.1 - 2026-06-16

- Fix provider registration for newer pi versions.
- Resolve npm audit findings.

### Contributors

- @user-a — fixed provider registration.
- @user-b — reported/validated retry behavior.
```

## Validation

Run the checks from `RELEASE.md`. For this repo, at minimum:

```sh
npm test
npm run typecheck
npm run format:check
npm audit --audit-level=moderate
npm pack --dry-run
git diff --check
```

If local pi auth makes `test:pi-local` use the wrong provider state, rerun the suite with a harmless mock Command Code API key in the environment instead of real auth.

If a live-auth test is needed and the user explicitly approves using local/server auth, use the repo helper if present. Never print API keys.

## GitHub Release notes

Always include:

- Summary of changes.
- Contributors section with GitHub handles.
- Validation section.
- Links to relevant PRs/issues.

## npm publish

Publish manually/local from the checked-out release commit:

```sh
npm publish --tag latest --access public
```

Verify:

```sh
npm view pi-commandcode-provider version dist-tags --json
npm view pi-commandcode-provider@<version> version --json
```

If npm auth fails, stop and ask the user to log in; do not read token files.

## Follow-up comments

After npm and GitHub Release are live, comment only on PRs/issues actually included in the release:

```txt
Shipped in `pi-commandcode-provider@<version>` / GitHub release `v<version>`.
```
