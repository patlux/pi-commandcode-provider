# Changelog

## Unreleased

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
