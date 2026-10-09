# Command Code for PiG (native Go)

Development package for [issue #143](https://github.com/patlux/pi-commandcode-provider/issues/143).
It is not published. The TypeScript package remains the supported Pi/OMP package.

## Runtime and installation

Use PiG commit `3452432f8b10edd244f7f44f73db8c97c00126cc` **with this repository's
compatibility patches**, and Go 1.26 or later. Follow the
[host patch build guide](https://github.com/patlux/pi-commandcode-provider/tree/143-native-pig-provider/patches/pig).
An unpatched host does not meet login, observer or signed-replay acceptance.
Published PiG 0.4.1 and installed older binaries are not supported by this port.

The package bundles the matching patched Go SDK with its licenses and provenance.
Its relative Go module replacement stays inside the installed package. It needs
no sibling checkout or absolute machine-local module replacement. Standard HTTP
clients remain in the separately pinned public PiG module; they are not copied.

The npm manifest declares only the Go factory. PiG compiles it into its extension
cache. Node is not part of provider execution. The package includes all provider
sources, its Go module/checksums, embedded model metadata, and license. First load
requires Go module downloads; later compilation can use the module cache.

For development, set `PIG_BIN` to a task-local pinned PiG binary, then use PiG's
`install` command with the absolute path to this package. Remove the TypeScript
Command Code extension from that PiG profile first. Do not install both providers
in the same profile. Keep the TypeScript package in separate Pi/OMP profiles.
Use PiG's `remove` command with the same package path to remove the native package.
No npm registry installation or release has been performed.

## Implemented paths

- Public PiG `ai.StreamSimple` OpenAI/Anthropic clients, with Command Code model
  compatibility settings. No copied standard clients or private protocol calls.
- Exact HTTP 403 `upgrade_required` fallback to the Go-plan `/alpha/generate`
  protocol, remembered per credential. Other errors do not authorize fallback.
- Text, reasoning, tools, token usage and reviewed display prices. Anthropic
  signed reasoning retains its signature when replayed through the direct client.
- API-key and OAuth-compatible login callbacks, key validation against
  `/alpha/whoami`, and a state-checked, one-shot loopback browser callback.
  Explicit host credentials, primary/legacy environment keys, and compatibility
  auth files are supported. Canceled login/refresh does not return credentials;
  invalid callback keys do not consume the one-shot login. Tests use synthetic
  callbacks, not a real browser.
- Public model discovery, atomic cache writes, offline fallback, coalesced refresh,
  complete size-bounded JSON validation and retention of the last good in-memory
  catalog after refresh failure (no rollback to stale disk state),
  `/commandcode-status`, `/commandcode-refresh`, and `/commandcode-quota` with
  partial-section failure handling.
- Awaited payload, response and raw-provider-event hooks across extension boundaries,
  with observer error propagation before event normalization.
- Actual CLI login, persisted credentials and reuse by a subsequent PiG process.
- Cancellation, connection closure and RPC stdin-EOF shutdown.

The catalog is generated from the existing TypeScript metadata and manually
reviewed pricing tables. It does not copy prices from live discovery. The current
source contains an expired Grok 4.7 promotion: the existing pricing test flags it.
Generating the Go snapshot does not validate or renew those prices.

## Verification in this repository

Set `PIG_BIN` to the patched binary. The required native E2E fails when it is absent.
Run `npm run test:pig`, `npm run test:pig-local`, `npm run test:pig-state`, and
`npm run test:pig-package` from the repository root. `npm run check:pig-catalog` verifies the generated snapshot;
`npm run generate:pig-catalog` regenerates it after an authoritative TS change.

Shared TypeScript/Go contract cases live in the package's
`extensions/pig-commandcode-provider/testdata/contracts.json`. Both native test
drivers read this single file; `npm run test:contracts` runs both without host
binaries or sockets. The native tarball includes the fixture, so its installed
Go tests use the same expectations. See the root contributing guide for adding
cross-language regressions. Runtime code remains separate: no Node bridge or
additional runtime dependency is introduced.

Mock tests use an isolated home/config/work directory, synthetic credentials,
allowlisted child environments and a loopback-only HTTP server. They do not use
real credentials or paid Command Code APIs. The Go race suite covers precise
fallback boundaries, key changes, auth validation, cache behavior, request options,
signed-reasoning replay, fragmented generate events and truncated streams.
Generate regression tests also cover byte-progress idle timeouts (including stalled
partial lines), HTTP-date and numeric `Retry-After`, capped backoff, cancellation
during retry waits, interleaved tools and immutable event snapshots. Final tool
arguments must be complete JSON objects; malformed or missing arguments fail the
stream rather than becoming empty or partially repaired tool input.
Auth regressions cover cancellation before/after prompts, during validation and
against an already buffered browser callback, plus invalid callback bodies that
must leave the one-shot login available. Catalog regressions cover malformed and
oversized documents, stale disk state and canceled refreshes without mutation.
The actual-host suite also covers signed Anthropic multi-turn history, real tool
roundtrips with duplicate terminal events, valid images, credential changes,
option/header forwarding (including ZDR on both routes), overflow recovery,
malformed tool rejection without execution or replay, subsequent session recovery,
direct registry replay without failed assistant turns or orphan tool results,
reload, background-refresh shutdown and observed descendant-process cleanup.
The state suite covers nine credential-source/precedence cases and cold/warm/offline
catalog recovery, rejected malformed refreshes, stale-cache rollback prevention,
plus automatic overflow compaction and retry with retained history. CLI login tests
also verify that 401/403/503 responses persist no credentials and a rejected
re-login preserves existing credentials. Both suites run against the exact installed tarball as well.

### Optional live profiles (not executed)

`npm run test:pig-live:go`, `npm run test:pig-live:goat`, and
`npm run test:pig-live:provider` require separate paid-test authorization. Supply
`COMMANDCODE_PIG_LIVE_CONFIRM=paid-one-request`, `PIG_BIN`, and the selected
`COMMANDCODE_E2E_GO_API_KEY` / `COMMANDCODE_E2E_GO_MODEL` pair (or the corresponding
`GOAT` / `PROVIDER` pair) through the approved credential route. Never put a key in
shell history or repository files. These profiles do not search credential files
or inherit the user's provider configuration.

Each uses one prompt, a 64-output-token limit, reasoning off, no tools, no retries,
a 30-second stream timeout and a 120-second RPC deadline. The Go profile can send
one rejected Provider request before its one Generate request. Model discovery is
also performed. The profile checks the observed transport, not the account's plan
or billing state. Its bounded request driver is exercised against mocks; real
Go/GOAT/Provider accounts and live cleanup remain unvalidated.

## Preliminary benchmark

`npm run benchmark:pig` uses the same synthetic streaming endpoint and prompt for
TS-on-PiG and Go-on-PiG. Set `PI_BIN` to include the Pi reference. Five sequential
samples per host include one cold extension cache and four warm restarts. Go's
module/compiler cache remains shared. Memory is aggregate host/descendant RSS at
readiness, not peak RSS. No real API latency or throughput claim is implied.

On macOS arm64, Go 1.27.1, patched PiG build
`3452432f8b10+commandcode-4490c614787f` and Pi 1.1.0, the latest five-sample run measured:
Shutdown measures stdin EOF to process close, excluding process-inventory checks
and the bounded descendant-reaping wait.

| Host      | Cold startup | Warm startup median | First event median | Request median | RSS median | Shutdown median |
| --------- | -----------: | ------------------: | -----------------: | -------------: | ---------: | --------------: |
| TS on Pi  |       285 ms |              289 ms |            30.9 ms |        32.0 ms |    141 MiB |          5.4 ms |
| TS on PiG |     1,639 ms |              372 ms |            14.5 ms |        17.2 ms |    208 MiB |          3.1 ms |
| Go on PiG |       602 ms |               95 ms |             5.7 ms |         6.5 ms |     94 MiB |          3.4 ms |

Both PiG variants sent four tool schemas and the same 65,536-token limit. The
benchmark reports host/tool-count differences instead of erasing them. Full
cold compiler-cache measurements and sustained-stream/peak-memory tests remain.

## Known gaps and remaining acceptance work

This is an implementation in progress, not a parity claim:

- Login, signed replay and response/raw-stream hooks require the explicit host
  patches above. They pass local mock acceptance; the fixes are not yet an
  upstream release. Cross-SDK conformance covers strict/packed and Go fused
  placements, including callback ordering, errors and cancellation.
- `ctx.Shutdown()` did not end the feasibility RPC session. Closing RPC stdin did
  end it with exit code 0. Tests use that supported shutdown path.
- `npm run test:pig-login` passes on the patched host after actual `pig install`,
  including validation, persistence and subsequent-process reuse. Prompted and
  synthetic state-checked browser callbacks also pass. The real browser UI and
  interactive TUI login remain unvalidated; prewritten credentials are not used
  as evidence for the CLI login gate.
- The three-host comparison covers OpenAI, Anthropic, exact Generate fallback,
  remembered routing, tool roundtrips on both routes, schema shape, history,
  usage and terminal results. Signed Anthropic reasoning replay passes for all
  three hosts with the patched PiG. Comparison output records the host versions
  and patchset digest. Shared Generate regressions also cover the TypeScript
  runtime, including invalid-tool rejection and recovery on all three hosts.
  Exhaustive option/model parity across all hosts remains.
  The existing Pi suite cannot be used unchanged on PiG because its agent-directory
  assumptions differ.
- Local macOS mock and tarball checks pass; remote Linux/macOS CI has not run.
  The root suite still fails its existing expired-price assertion. Its remaining
  tests pass, including actual Pi; task-local OMP 18.8.6 also passes. The exact root
  TypeScript tarball passes both Pi and OMP smoke suites. These are not complete
  green-suite or release-readiness claims.
- Live Go/GOAT/Provider-account validation is not part of mock test evidence.
- Existing root release automation publishes only `pi-commandcode-provider`.
  Native releases need separate package/version/tag/OIDC setup and maintainer
  authorization. The native development version is independent of the root version.
