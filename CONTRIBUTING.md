# Contributing

Thanks for helping improve `pi-commandcode-provider`.

This is an unofficial Command Code provider for pi. Keep changes small, tested, and easy to review.

## Development setup

```sh
npm install
npm test
```

Useful commands:

```sh
npm run typecheck
npm run format:check
npm run test:unit
npm run test:models
npm run test:oauth
npm run test:abort
npm run test:stream
npm run test:pi-isolated
npm run test:pi-authenticated
npm run test:pi-local
```

Start an isolated pi instance with only the current checkout installed and no existing Command Code credentials:

```sh
npm run pi:isolated
```

Run `/login` inside pi. Temporary credentials, configuration, and sessions are deleted when pi exits.

Start the current checkout with your existing pi credentials and only Command Code models in the model picker:

```sh
npm run pi:authenticated
```

Both commands accept additional pi arguments after `--`, for example `npm run pi:authenticated -- --model claude-sonnet-4-6`.

Run the transport-specific live tests with separate credentials:

```sh
COMMANDCODE_E2E_GO_API_KEY_FILE=/path/to/go-key npm run test:e2e:live:go
COMMANDCODE_E2E_GOAT_API_KEY_FILE=/path/to/goat-key npm run test:e2e:live:goat
COMMANDCODE_E2E_PROVIDER_API_KEY_FILE=/path/to/provider-key npm run test:e2e:live:provider
```

Use `npm run test:e2e:live:all` with the Go and GOAT file variables to run both subscription transports sequentially. Store keys in a secret manager and export each one to a new mode-`0600` temporary file for the test; never add key files to the repository. Direct `*_API_KEY` variables are intended primarily for protected CI secrets.

### pi end-to-end

`tests/test-pi-local.mjs` runs the extension inside a real `pi` binary against a mock Command Code API, including every credential source (`/login` OAuth and API-key credentials, `--api-key`, env keys). It skips locally when `pi` is not on `PATH`; CI installs pi and runs it as part of `npm test` with `PI_LOCAL_REQUIRED=1`. Point `PI_BIN` at another pi executable to test against a specific version.

### Oh My Pi compatibility

`tests/test-omp-compat.mjs` runs the extension inside a real `omp` binary against a mock Command Code API. It skips locally when `omp` is not on `PATH`; CI installs Oh My Pi and runs it as a required check with `OMP_COMPAT_REQUIRED=1`, so a change that only loads on pi fails CI instead of the next `omp plugin install`.

To run it locally, point `OMP_BIN` at an omp executable (Oh My Pi needs Bun ≥ 1.3.14):

```sh
npm install -g @oh-my-pi/pi-coding-agent
OMP_BIN="$(npm prefix -g)/bin/omp" node tests/test-omp-compat.mjs
```

Before opening a PR, run:

```sh
npm test
npm run format:check
git diff --check
```

For release and npm smoke-test steps, see [RELEASE.md](RELEASE.md). Releases use a
merged release PR followed by a `vX.Y.Z` (stable) or `vX.Y.Z-next.N` tag push; the
release workflow is the only publishing path, including recovery, and publishes the
tested tarball through npm Trusted Publishing (OIDC).
The canonical repository's activation was verified with `0.7.3-next.0` on 2026-09-26;
see the [activation record](RELEASE.md#activation-record). Setup changes and maintainer
permissions remain separate owner tasks. `RELEASE.md` is the single release guide
for maintainers and coding agents.

Release-rule tests run as part of `npm test`, or separately with `npm run test:release`.
To test a packed artifact with real Pi and OMP against mock APIs, run
`npm run test:release-package -- /path/to/package.tgz`; both hosts and Bun are required.
Validate workflow edits with `actionlint`.

### Native PiG package

The separate native package guide documents the pinned host and bundled SDK.
Follow the [patch build guide](patches/pig/README.md) to build the required patched
PiG task-locally; do not replace a user's installed binary. With `PIG_BIN` set, run:

```sh
npm run check:pig-catalog
npm run check:pig-sdk
npm run test:pig-patches
npm run test:pig
npm run test:pig-local
npm run test:pig-state
npm run test:pig-package
npm run test:pig-comparison
npm run test:pig-login
```

Set `PI_BIN` for the third-host comparison. `npm run benchmark:pig` records repeated
cold-extension/warm-start measurements. Native tests fail rather than skip when
`PIG_BIN` is absent. They use mock endpoints and synthetic credentials only.
The exact tarball is tested outside the checkout, including PiG installation,
discovery and removal. `npm run generate:pig-catalog` exports authoritative TS
metadata and reviewed prices; it does not fetch or approve new prices.
`test:pig-login` verifies actual CLI login, validation, persistence and reuse in a
new process. It and the three-host signed-reasoning comparison pass on the patched
host and remain required CI gates. Response/raw-event observer assertions cover
both transports. Native SDK sources are package-owned; the Go replacement must
stay inside the installed package. `check:pig-sdk` verifies its reviewed hashes
and optionally compares it to an absolute patched PiG checkout path.
See the native guide for optional bounded live profiles; do not execute them
without separate paid-test/credential authorization.

The native package has its own version. Existing release automation does not
publish it. Do not add native tags/publication to the root package release flow.

### Shared TypeScript/Go contracts

Run `npm run test:contracts` to check both native implementations against the same
reviewed JSON fixtures. Use `npm run test:contracts:ts` or
`npm run test:contracts:go` for one language. No host binary, credentials or network
listener is needed. Go dependencies must already be cached for a fully offline run.

The single fixture source is
`packages/pig-commandcode-provider/extensions/pig-commandcode-provider/testdata/contracts.json`.
It lives inside the native package so `go test` also checks the exact installed
artifact without a sibling checkout. TypeScript reads that file directly; do not
copy it or generate expectations from either implementation's output.

The two thin drivers exercise production history conversion, the Generate stream
parser and HTTP retry handling. The stream cases feed one byte at a time, including
UTF-8 boundaries, and check terminal events, completed tools, content and usage.
Invalid tool arguments must fail without completion or retry. Failed/aborted
assistant history is omitted, and text-only models omit tool images while retaining
text or an omission notice. User images still require image support.

For a cross-language regression, add an input and explicit expected behavior to
this fixture, demonstrate failure, then fix the affected implementation. Keep
runtime-specific cancellation, timers, auth, observer and race tests in their
existing suites. These contracts are not exhaustive host or protocol parity.
The real three-host comparison also reuses the invalid-tool fixture and verifies
recovery; it checks streamed arguments and duplicate terminal events in real tool
roundtrips. `npm test` and `test:unit` include the TS driver; `test:pig` and the
installed-native-package test include the Go driver, so existing CI gates run both.

Model metadata and reviewed prices continue to use the existing TS-to-Go catalog
generator. There is no shared runtime, subprocess bridge or new dependency. Only
move further rules into shared data when they are genuinely declarative; do not
build a second programming language in JSON.

## Pull request guidelines

- Keep PRs focused on one problem or feature.
- Add or update tests for behavior changes.
- Update `README.md`, `CHANGELOG.md`, or `RELEASE.md` when user-facing behavior changes.
- Avoid broad refactors unless the PR is specifically about refactoring.
- Do not include API keys, tokens, real auth files, `.env` files, or other secrets.
- Prefer documented/public Command Code API behavior. If compatibility with CLI behavior is needed, document why.
- Make sure npm package contents still make sense when `package.json` `files` changes.

## Testing pi integration changes

For provider, auth, request-shape, or stream changes, test both local code and the package form when possible.

Local extension smoke:

```sh
pi --no-extensions -e ./index.ts --list-models commandcode
```

Packed-package smoke testing is documented in [RELEASE.md](RELEASE.md#local-package-smoke-test).
Use the isolated launchers above for a separately authorized manual `/login` test.

## Commit message rules

Use Angular-style Conventional Commits.

Format:

```txt
<type>(<scope>): <subject>
```

Examples:

```txt
feat(auth): support Command Code CLI auth files
fix(core): cap max tokens by selected model
docs(release): document npm smoke testing
test(stream): cover reasoning start events
chore(release): publish 0.1.1
```

### Types

Use one of these types:

- `feat`: a new user-facing feature
- `fix`: a bug fix
- `docs`: documentation-only changes
- `style`: formatting-only changes, no behavior change
- `refactor`: code restructuring without behavior change
- `perf`: performance improvement
- `test`: adding or changing tests
- `build`: package, dependency, or build-system changes
- `ci`: CI workflow changes
- `chore`: maintenance that does not fit another type
- `revert`: revert a previous commit

### Scopes

Use a short lowercase scope. Prefer existing project areas:

- `auth`
- `oauth`
- `core`
- `models`
- `stream`
- `tests`
- `docs`
- `release`
- `deps`
- `ci`

A scope is strongly recommended. If no scope fits, choose the closest project area instead of omitting it.

### Subject line

- Use imperative mood: `fix(auth): read oauth credentials`, not `fixed` or `fixes`.
- Keep it concise.
- Start lowercase after the colon.
- Do not end with a period.

### Body and footers

Use a body when the reason is not obvious:

```txt
fix(core): cap max tokens by selected model

Command Code can return models with lower output limits than the provider-wide cap.
Clamp defaults to the selected model so requests do not exceed upstream limits.
```

Breaking changes must be marked with `!` or a `BREAKING CHANGE:` footer:

```txt
feat(api)!: switch to provider api endpoints

BREAKING CHANGE: removes support for the legacy internal generate endpoint.
```
