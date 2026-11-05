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

### Entrypoint static validation

`npm run typecheck` checks the host-independent source, unit tests, and maintenance
scripts. The extension entrypoint has a separate **required CI gate** against the
real declarations of the Pi package installed for the integration tests:

```sh
npm run typecheck:entrypoint -- "$(npm root -g)/@earendil-works/pi-coding-agent"
```

For a non-npm/global installation, pass the installed package directory containing
Pi's `package.json` (not the CLI wrapper). If the optional Pi peers are already
resolvable from the checkout, the directory argument may be omitted. This command
fails when host declarations are missing; it never installs packages or silently
skips. It uses `tsconfig.entrypoint.json` and also compiles the positive/negative
contracts in `tests/types/entrypoint.ts`. No ambient host stubs, error baseline,
private host dependencies, or broad boundary casts stand in for the real types.
`skipLibCheck` is inherited from the unit project: upstream declaration internals
are not audited, but our source and its use of the host contracts are checked.

This static gate targets Pi's public declarations. Real Pi **and** Oh My Pi mock
integration tests remain necessary to cover runtime exports, loader aliases, and
Go/GOAT transport behavior; this does not claim an OMP declaration-level check.

### Oh My Pi compatibility

`tests/test-omp-compat.mjs` runs the extension inside a real `omp` binary against a mock Command Code API. It skips locally when `omp` is not on `PATH`; CI installs Oh My Pi and runs it as a required check with `OMP_COMPAT_REQUIRED=1`, so a change that only loads on pi fails CI instead of the next `omp plugin install`.

To run it locally, point `OMP_BIN` at an omp executable (OMP 18.16.0 requires Bun ≥ 1.4.4; check the installed version's engine requirements):

```sh
npm install -g @oh-my-pi/pi-coding-agent
OMP_BIN="$(npm prefix -g)/bin/omp" node tests/test-omp-compat.mjs
```

### Protocol and host contracts

`npm run test:host-protocols` checks the helper regressions, then runs available Pi
and OMP binaries against loopback mocks over Chat Completions, Responses and
Anthropic Messages. It verifies system instructions, reasoning replay (including
encrypted/signed reasoning), two tool-call/result pairs, and actual image payloads
on the follow-up request. Homes and credentials are synthetic and isolated; no
live API calls are made. Set `COMMANDCODE_CONTRACT_HOST=pi` or `omp` to select a
host. `PI_LOCAL_REQUIRED=1` and `OMP_COMPAT_REQUIRED=1` make missing selected hosts
fail instead of skip. `PI_BIN` and `OMP_BIN` select explicit binaries.

`npm run test:routing` covers persisted endpoint choices and private recovery
backups. `npm run test:routing-hosts` drives the real Pi and OMP RPC lifecycles:
command, catalog refresh, emitted wire, reasoning/tool follow-up, auto reset,
restart, malformed-file warning and explicit repair. It uses the same host
selection/required flags and bounded process helper as the protocol contracts.
Both suites run in `npm test`; the OMP CI job also requires the routing-host
suite, and the package smoke runner targets the installed artifact.

The fixtures depend on reasoning and image capabilities for DeepSeek V4.1 Flash,
Muse Spark 1.3 and Claude Sonnet 4.6. A preflight extension checks those catalog
capabilities, the common `high` thinking effort and routing rules in the tested
checkout or installed package before registering tools. Responses also checks that a long native item-ID suffix does
not leak into replayed call IDs; this is not the generate fallback's #141 test.

Host timeouts signal the isolated POSIX process group with SIGTERM then SIGKILL,
including descendants that retain inherited pipes. On Windows only the direct
child is signalled. The helper normally waits for `close` and retains late output;
if stdio still has not closed after the final grace period, it destroys its read
pipes, unreferences the child and fails with cleanup explicitly unconfirmed.
This bounds the runner, not arbitrary descendants that escape the process group.

PR CI continues to test `@latest` hosts with the required Pi entrypoint gate and
Bun 1.4.4 for OMP. No older host baseline or weekly-only drift gate is introduced.
The package smoke runner also executes these contracts against the installed
artifact; see `RELEASE.md` for that separately authorized installation.

Before opening a PR, run:

```sh
npm test
npm run typecheck:entrypoint -- /path/to/installed/@earendil-works/pi-coding-agent
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
