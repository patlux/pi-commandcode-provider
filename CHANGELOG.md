# Changelog

## Unreleased

- Use the host-provided `pi-ai` and `pi-coding-agent` core packages instead of installing private runtime copies, including for local and out-of-store development checkouts.
- Forward pi's thinking level to the Command Code API via `params.thinking = { type: "enabled" }` so reasoning traces are produced reliably instead of depending on upstream's own decision.
- Stop echoing reasoning blocks from assistant history back to the API; upstream treats past reasoning as the answer to later questions and stops thinking in subsequent turns.
- Convert pi image content blocks and tool-result image attachments into base64 image parts the `alpha/generate` API accepts, so pasted screenshots and image tool results are sent as user-role images.

## 0.4.4 - 2026-08-03

- Fix cached input tokens being counted twice.

## 0.4.3 - 2026-08-02

- Allow pi to start when model discovery is unavailable. The provider now caches the last successfully fetched model catalog so previously discovered Command Code models remain selectable offline; a first offline start without a cache keeps Command Code unavailable until `/reload` succeeds.

### Contributors

- @k3-2o — reported that the model-list fetch blocked pi startup when offline.

## 0.4.2 - 2026-07-05

- Fix Oh My Pi extension validation by avoiding the missing `calculateCost` export from OMP's legacy `pi-ai` shim.
- Add a regression test that locks the local Command Code cost calculation to pi-ai's upstream `calculateCost` behavior.

### Contributors

- @CoderTCY — reported the Oh My Pi installation failure.

## 0.4.1 - 2026-06-16

- Use the explicit `$COMMANDCODE_API_KEY` provider registration syntax expected by newer pi versions, removing the startup deprecation warning while keeping legacy placeholder compatibility.
- Refresh development dependency lockfile entries to resolve npm audit findings for `tsx`/`esbuild` and `protobufjs`.

### Contributors

- @plumj-am — fixed the pi provider `apiKey` deprecation warning.
- @cad0p — reported retry/deprecation-related issues that helped validate the current behavior.
- @bl4zee1g — reported provider availability concerns that prompted additional local/live validation.

## 0.4.0 - 2026-06-02

- Add retry mechanism for transient HTTP errors (429, 5xx) and stream-level errors, configurable via pi `settings.json` `retry.provider` fields (`timeoutMs`, `maxRetries`, `maxRetryDelayMs`). Supports exponential backoff with jitter and `Retry-After` header.

## 0.3.1 - 2026-05-29

- Bump CLI version header to `0.29.0` for Command Code API parity.
- Harden PR security pipeline CI configuration.

## 0.3.0 - 2026-05-28

- Add OMP (Oh My Pi) provider compatibility: support `~/.omp/agent/auth.json` auth path, handle OMP's env-var-name-as-apiKey quirk, convert OMP system prompt arrays to text.
- Close open thinking blocks before starting text or tool output to prevent event ordering issues when upstream omits `reasoning-end`.
- Correct DeepSeek V4 Pro discount as permanent (no expiry), not time-limited.
- Correct DeepSeek V4 Flash cache-read rate to $0.028/M and add xiaomi/mimo models to pricing table.
- Upgrade pi dependencies from `@mariozechner` 0.72.0 to `@earendil-works` 0.75.5.
- Move `pi-coding-agent` to optional peerDependencies.

## 0.2.0 - 2026-05-27

- Stream `reasoning-delta` events incrementally instead of buffering the full thinking block until `reasoning-end`. Emits `thinking_start`, `thinking_delta`, and `thinking_end` events as they arrive so the UI can show reasoning in real time.
- Close open text blocks on `reasoning-start` and `reasoning-delta` so thinking and text never overlap in the output.
- Add live display pricing (`MODEL_COSTS`) for known Command Code models. Cost falls back to zero for models not yet in the price table until the Provider API exposes pricing directly.
- Fetch models from the Command Code Provider API at startup (inherited from upstream 0.1.1) and overlay the static cost table.

## 0.1.1 - 2026-05-26

- Align Command Code generate requests with CLI `0.27.2` headers and payload shape.
- Support official Command Code CLI auth files using the `command-code` credential key.
- Handle `reasoning-start` and ignore streamed `tool-result` events.
- Cap generated `max_tokens` by the selected model and the Command Code output limit.

## 0.1.0 - 2026-05-05

- Initial public release.
