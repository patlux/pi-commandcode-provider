# Task-local PiG compatibility patches

These patches support the native Command Code development package. They are not
an upstream release, a change to an installed PiG, or a claim of full PiG parity.
The base is `MichaelKinsy/PiG@3452432f8b10edd244f7f44f73db8c97c00126cc`.

## Patch ownership

1. Native CLI auth: accept native provider declarations in the auth inspector so
   connection-owned OAuth callbacks register and retire correctly. Do not start a
   Model Runtime or refresh credentials merely to inspect login targets.
2. Signed replay: defer API-specific signature stripping until the selected API
   leaf. Preserve Agent tool-flow repair and filtering of incomplete turns.
3. Observers: forward awaited response and raw-provider-event callbacks through
   the host, Go/Python/Rust SDKs and Node bridge. Preserve operation cancellation,
   errors, model identity and callback order. Include cross-SDK regression tests.
4. Generated Go interface inventory: retain the output of upstream `make generate`
   for the two new helpers. The SDK surface matrix has no generated diff.

`series.json` pins the base and SHA-256 of each patch. `sdk-snapshot.json` hashes the
production SDK bundled in the native npm package. Both inventories must be
reviewed when changing the patches. The bundle contains no provider HTTP clients.
All upstream copyrights and licenses remain intact.

## Reproduce without installation

Use a new disposable checkout at the exact base. The apply script rejects a wrong
revision or dirty checkout, validates patch hashes, and checks all patches before
writing. Supply absolute paths. For example, with `PROVIDER_REPO` pointing to this
repository and `PIG_SOURCE` pointing to the disposable checkout:

```sh
node "$PROVIDER_REPO/scripts/apply-pig-patches.mjs" "$PIG_SOURCE"
node "$PROVIDER_REPO/scripts/check-pig-sdk.mjs" "$PIG_SOURCE"
make -C "$PIG_SOURCE" node-runtime
patchset=$(node -e 'const fs = require("node:fs"), crypto = require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex").slice(0, 12))' "$PROVIDER_REPO/patches/pig/series.json")
(cd "$PIG_SOURCE" && CGO_ENABLED=0 go build -buildvcs=false -trimpath \
  -ldflags "-s -w -X main.Build=3452432f8b10+commandcode-$patchset" \
  -o "$PIG_SOURCE/pig-commandcode-test" ./cmd/pig)
export PIG_BIN="$PIG_SOURCE/pig-commandcode-test"
```

The Node runtime archive is generated, not copied into the patchset. Skipping
`make node-runtime` ships the old JavaScript bridge despite patched source files.
CI uses the same procedure on Linux and macOS. Comparison output records the
actual host version and patchset digest and rejects an incorrectly identified
PiG build. No install command, global binary replacement, commit, or publication
is part of these steps.

## Local validation and limits

- Patches applied to a fresh exact-revision checkout; its built host passed native
  local/state/login tests, exact npm tarball installation/removal, and the
  three-host semantic comparison.
- Agent/auth/lifecycle callback regressions and the Go SDK race suite pass.
  Provider-object conformance passes with the Go race detector across Go, Python,
  Rust and Node owners/readers in strict/packed placements, plus Go fused cases.
- Python SDK pytest passes. Rust SDK library tests pass through `mbx`.
- Upstream `make upstream-mirror` and full `make generate` completed with the
  pinned Pi 1.0.3 comparator; `make sdk-surface-drift` and the Node archive/source
  consistency test pass. Generation also rewrote three unrelated highlighting
  gzip assets in the disposable checkout. Those changes are not included here.
- Upstream-wide `cargo fmt --check` reports existing formatting drift, including
  unrelated files. This patchset does not reformat the SDK wholesale.
- RPC exit deliberately kills runtime children without joining them. Harness
  cleanup checks their disappearance for up to two seconds after host exit;
  this cleanup interval is not reported as host shutdown latency.
- Remote CI, upstream acceptance/publication, interactive browser login and paid
  account tests remain unrun. The root pricing expiry gate remains unresolved.

These are temporary host compatibility patches. Remove them and the package SDK
snapshot only after a pinned upstream release supplies the behavior and the same
mock/artifact acceptance gates pass without patches.
