# Release Process

This project uses npm semver releases.

Recommended flow:

- publish prereleases with the `next` dist-tag
- smoke-test the npm package directly in pi
- publish stable releases with the `latest` dist-tag
- commit the release on a branch, open a PR, and merge after CI passes
- tag the stable release on `main` after merge
- comment on the related PR or issue after shipping

## Prerelease flow

Use `next` for beta/alpha/manual validation builds.

```sh
npm version prepatch --preid next --no-git-tag-version
npm test
npm run format:check
npm pack --dry-run
npm publish --tag next --access public
```

If npm asks for browser or OTP auth, run the publish command manually and complete the npm prompt.

Verify the registry state:

```sh
npm view pi-commandcode-provider@next version dist-tags --json
```

Expected:

- `next` points to the prerelease version
- `latest` still points to the previous stable version

## Test the npm package in pi

Always test from npm, not the local checkout.

### 1. Model discovery smoke test

```sh
PI_SKIP_VERSION_CHECK=1 \
pi --no-extensions \
  -e npm:pi-commandcode-provider@next \
  --list-models commandcode
```

Expected:

- provider `commandcode` appears
- live Command Code models are listed

### 2. Manual `/login` test with isolated pi config

Use temporary pi config and session directories so the test does not touch your real pi auth.

```sh
export PI_CC_TEST_AGENT_DIR="$(mktemp -d)"
export PI_CC_TEST_SESSION_DIR="$(mktemp -d)"

export PI_CODING_AGENT_DIR="$PI_CC_TEST_AGENT_DIR"
export PI_CODING_AGENT_SESSION_DIR="$PI_CC_TEST_SESSION_DIR"
export PI_SKIP_VERSION_CHECK=1

pi --no-extensions \
  -e npm:pi-commandcode-provider@next \
  --provider commandcode \
  --model deepseek/deepseek-v4-flash
```

Inside pi:

```txt
/login
```

Then:

1. choose **Use a subscription**
2. choose **Command Code**
3. complete the browser auth flow
4. if automatic transfer fails, paste the copied Command Code API key into pi
5. send this message:

```txt
Reply exactly: manual-npm-ok
```

Expected:

- login succeeds
- a Command Code credential is saved under the temporary `PI_CODING_AGENT_DIR`
- the model replies exactly `manual-npm-ok`

### 3. Post-login print-mode test

Using the same exported temp variables from above:

```sh
pi --no-extensions \
  -e npm:pi-commandcode-provider@next \
  --no-session \
  -p \
  --provider commandcode \
  --model deepseek/deepseek-v4-flash \
  "Reply exactly: manual-npm-ok"
```

Expected:

```txt
manual-npm-ok
```

### 4. Cleanup isolated pi config

Only run this if these variables were created by the test above:

```sh
rm -rf "$PI_CC_TEST_AGENT_DIR" "$PI_CC_TEST_SESSION_DIR"
unset PI_CC_TEST_AGENT_DIR PI_CC_TEST_SESSION_DIR
unset PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR PI_SKIP_VERSION_CHECK
```

## Stable release flow

After the `next` package is verified, set the intended stable version:

```sh
npm version 0.1.1 --no-git-tag-version
```

Replace `0.1.1` with the intended stable version.

Update `CHANGELOG.md`, then run checks:

```sh
npm test
npm run format:check
npm pack --dry-run
git diff --check
```

Commit on a release branch and open a PR:

```sh
git checkout -b release/0.1.1
git add .
git commit -m "Release 0.1.1"
git push origin release/0.1.1
gh pr create --title "chore(release): publish 0.1.1" --base main
```

`main` is branch-protected. The release must go through a PR with passing CI.

Once CI passes, approve and merge:

```sh
gh pr review <number> --approve
gh pr merge <number> --squash --delete-branch
```

After merge, pull `main` and tag locally:

```sh
git checkout main
git pull origin main
git tag -a v0.1.1 -m "Release 0.1.1"
git push origin v0.1.1
```

Publish stable locally:

```sh
npm publish --tag latest --access public
```

Publishing is intentionally manual/local; there is no GitHub Actions publish workflow. If npm asks for browser or OTP auth, complete the npm prompt locally.

Verify npm:

```sh
npm view pi-commandcode-provider version dist-tags --json
npm view pi-commandcode-provider@0.1.1 version --json
```

Expected:

- `latest` points to the stable version
- the stable version exists on npm

## GitHub follow-up

Comment on the related PR and issue after publishing and pushing:

```sh
gh pr comment <number> --body "Shipped in \`pi-commandcode-provider@0.1.1\` / tag \`v0.1.1\`."

gh issue comment <number> --body "Shipped in \`pi-commandcode-provider@0.1.1\` / tag \`v0.1.1\`."
```

Only comment on PRs or issues actually included in the release.
