# Changelog

## Unreleased

- Stop registering the unresolved `$COMMAND_CODE_API_KEY` placeholder as a provider `apiKey` when no env or auth-file key is configured. Oh My Pi treats that literal as a config override, which shadowed `/login` OAuth credentials and sent `Authorization: Bearer $COMMAND_CODE_API_KEY` (401). Chat now uses the stored OAuth key, matching `/commandcode-quota`.

## 0.6.2 - 2026-09-02

- Fix `omp plugin install` on Oh My Pi 18.x, which rejected 0.6.1 because its pi-ai lacks the `registerApiProvider` export; the compat registration now resolves at runtime and is skipped on hosts that register custom APIs themselves.
- Run the Oh My Pi compatibility suite against a real `omp` binary in CI as a required check, and assert there that the extension loads against OMP's bundled pi packages.
- Pin the CI memory benchmark and Oh My Pi jobs to Bun 1.4.0, Node 22.23.2, and pi 0.84.4.

### Contributors

- @AmeMizuki — reported the failing `omp plugin install` on Oh My Pi 18.1.2.

## 0.6.1 - 2026-09-01

- Expose selectable thinking levels (`minimal`, `low`, `medium`, `high`, `xhigh`) for `meta/muse-spark-1.1`, `meta/muse-spark-1.2`, and `meta/muse-spark-1.2-contributor` through a manual catalog override, so `/thinking` and `Shift+Tab` no longer stay locked on `off` for these reasoning models.
- Start from the cached model catalog and refresh it in the background instead of blocking host startup on the catalog request; a first start without a cache still waits for the live catalog.
- Register the `commandcode-custom` API in the `@earendil-works/pi-ai/compat` registry so sibling extensions that stream with the active Command Code model no longer fail with `No API provider registered for api: commandcode-custom` on plain pi.
- Assert structural catalog invariants in the model tests so the daily catalog sync no longer fails on every upstream change.
- Display the monthly renewal date and remaining days in `/commandcode-quota`.
- Stop silently dropping `role: "developer"` messages (for example OMP advisor steering notes, reminders, and nudges). `/alpha/generate` only accepts `user`, `assistant`, and `tool` roles, so developer messages are now forwarded as `user` messages with identical content in the same chronological position instead of disappearing from the request.
- Add `Qwen/Qwen3.8-Flash` and `z-ai/glm-5.3-flash` with their verified reasoning efforts (`low, medium, xhigh` and `low, high, max`) and display pricing.
- Refresh static model capabilities from `command-code@1.40.1`, adding `claude-fable-5-1`, `deepseek/deepseek-v4-flash-fast`, and `tencent/hy4-preview` with their reasoning efforts, adding `moonshotai/Kimi-K3` efforts and the `z-ai/glm-5.3-flash` output limit, and dropping the retired `stealth/ox-alpha` and `minimax/minimax-m3-free`.
- Refresh display pricing for the current 62-model catalog, adding `claude-fable-5-1`, `deepseek/deepseek-v4-flash-fast`, and `tencent/hy4-preview`, removing the retired `stealth/ox-alpha`, `minimax/minimax-m3-free`, and `minimax/minimax-m2.7-free`, and ending the expired Claude Sonnet 5 introductory and Gemini 3.7 Flash promotional windows.
- Fix `npm run sync:commandcode-catalog` and `npm run check:commandcode-catalog` on Windows by spawning npm through the shell.
- Add a `refresh-model-catalog` agent skill with cross-platform helper scripts that snapshot the live model catalog and regenerate the pricing fixture from `MODEL_COSTS`.

### Contributors

- @warc0s — preserved developer messages on the `/alpha/generate` transport with OMP advisory coverage.
- @jagaliano — added the quota renewal date and diagnosed the failing daily catalog sync.
- @ThomasByr — added GLM 5.3 Flash and Qwen 3.8 Flash and contributed the `refresh-model-catalog` skill.
- @hjshin-ubob — proposed selectable thinking levels for the Muse Spark models.
- @Sokoshy — analyzed the `commandcode-custom` compat registry failure on plain pi.
- @CoderTCY — measured and proposed the cache-first catalog startup.
- @MertSoylu — reported the missing GLM 5.3 Flash effort levels.

## 0.6.0 - 2026-08-25

- Allow switching from a vision-capable model to a text-only model by omitting historical image tool results while preserving their text output; direct image prompts still fail clearly.
- Stream incremental tool-call arguments from the `/alpha/generate` transport instead of waiting for the final complete tool-call event.
- Add a daily GitHub Actions synchronization job that opens or updates a pull request for CLI version, image capability, reasoning, effort, and output-limit changes in the latest published Command Code catalog.
- Refresh static model capabilities from `command-code@1.32.2`, separating reasoning support from selectable effort levels and honoring model-specific output limits.
- Reject truncated, aborted, and network-failed generate streams instead of reporting partial responses as successful.
- Normalize malformed tool results and synthesize missing tool results so follow-up requests preserve valid tool-call history.
- Refresh display pricing for all 58 current models, including Gemini 3.7 Flash, Qwen 3.8 27B, Ox Alpha, Muse Spark 1.2, and Grok 4.6 long-context rates.
- Accept the official `COMMAND_CODE_API_KEY` and `CMD_ZDR` environment variables while retaining legacy aliases.
- Align generate request metadata with the CLI by forwarding stable session IDs, optional temperature, and the CLI user agent.
- Validate manually pasted API keys, use the CLI's two-minute browser timeout, and reject OAuth state mismatches without closing the callback server.
- Add `/commandcode-quota` with live credits, plan, usage totals, and rolling-limit diagnostics from Command Code's alpha usage endpoints.
- Add `zai-org/GLM-5.3` with its verified reasoning efforts and display pricing.
- Prefer Command Code's Provider API (`/provider/v1/chat/completions` and `/provider/v1/messages`) and automatically fall back to the existing `/alpha/generate` transport only when the Provider API returns `403 upgrade_required` for a Go-plan account.
- Remember the detected transport for the running process, re-detect it when credentials change, prevent stale in-flight requests from overwriting the new credential's transport, and never fall back for unrelated authentication, permission, rate-limit, network, or server failures.
- Use Pi's native OpenAI- and Anthropic-compatible providers for Provider API streaming, including adaptive thinking for current reasoning-capable Claude models, while preserving the existing hardened generate transport, dynamic model discovery, offline cache, refresh/status commands, pricing, and OAuth credentials.
- Let `/login` use browser authentication, an explicit API-key prompt, or a directly pasted API key.
- Add optional zero-data-retention headers through `CMD_ZDR=1` and the legacy `COMMANDCODE_ZDR=1` alias.
- Refresh GPT-5.6 Terra and Luna display prices after their temporary 50% promotion ended, and display the current DeepSeek V4 off-peak rates for its time-dependent pricing.
- Add isolated live E2E profiles for separate Go-, GOAT-, and Provider-plan credentials, covering transport selection, reasoning across turns, quota identity, aborts, tools, GOAT vision, Go image rejection, and packed-package validation.
- Fix extension load failure on newer pi hosts that reject registering a custom API under a built-in name (`openai-completions`); register under `commandcode-custom` instead and restore the real wire API before native compat dispatch.

### Contributors

- @jagaliano — added the live quota dashboard and hardened its integration.
- @omariqbalnaru — fixed custom API registration for Oh My Pi 17.4.0.
- @ThomasByr — added GLM-5.3 pricing and reasoning levels.
- @newCman1 — added DeepSeek V4 vision model support.

## 0.5.1 - 2026-08-11

- Add model-specific image input capabilities from the `command-code@1.15.1` catalog and forward user and tool-result images using the current Command Code wire format.
- Update the Command Code client version header to `1.15.1`.

### Contributors

- @DiyarD — reported missing vision support for GPT-5.6 Luna, Muse Spark 1.2, and other vision-capable models.

## 0.5.0 - 2026-08-07

- Stop replaying completed assistant reasoning traces to Command Code while preserving visible text and completed tool calls in follow-up request history.
- Add `/commandcode-refresh` and `/commandcode-status` commands for safe model-catalog refreshes and redacted diagnostics.
- Bound model discovery to a configurable 10-second timeout so a slow Provider API cannot block pi startup; timed-out discovery uses the validated cache when available.
- Normalize Command Code context overflow failures so pi can auto-compact and retry, while leaving unrelated rate-limit and capacity errors unchanged.
- Keep the legacy `/alpha/generate` integration explicitly text-only: image input and image tool results are rejected instead of being silently dropped, and models do not claim image capability until the protocol exposes documented support and limits.
- Replace blanket reasoning metadata with model-specific Command Code effort support. Known models expose a `thinkingLevelMap`, and selected supported Pi levels are forwarded as `params.reasoning_effort`; unsupported or unknown models do not receive reasoning request fields.
- Add repository commands for testing the current checkout either in a logged-out, automatically cleaned-up pi environment or with existing credentials and only Command Code models enabled.
- Refresh display pricing for the current Command Code model catalog, remove expired Qwen promotional rates, add current free and discounted models, and require review when temporary prices expire.
- Use the host-provided `pi-ai` and `pi-coding-agent` core packages instead of installing private runtime copies, including for local and out-of-store development checkouts.
- Fix cached input tokens being counted twice.

### Contributors

- @IfkumRfnl — fixed cached input token accounting.

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
