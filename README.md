# pi-commandcode-provider

[![CI](https://github.com/patlux/pi-commandcode-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/patlux/pi-commandcode-provider/actions/workflows/ci.yml)
[![Memory benchmark](https://github.com/patlux/pi-commandcode-provider/actions/workflows/memory-benchmark.yml/badge.svg)](https://github.com/patlux/pi-commandcode-provider/actions/workflows/memory-benchmark.yml)

A custom provider for [pi](https://github.com/earendil-works/pi) that connects to the [Command Code](https://commandcode.ai) Provider API.

> **Disclaimer:** This is an unofficial, community-maintained integration. It is not affiliated with, endorsed by, or supported by Command Code. You need your own Command Code account, API key, and a plan with Provider API access. Command Code's terms, availability, and pricing apply.

## Breaking migration: Provider API access required

The next breaking release removes automatic `/alpha/generate` fallback. A `403 upgrade_required` now stops with an actionable error; it never retries your prompt against the internal CLI endpoint. The [official Provider API documentation](https://commandcode.ai/docs/provider) excludes API use from the Go plan. A working login or quota response does not establish API entitlement.

If you used the Go fallback:

1. Check the current documented plans and model access with Command Code. Use an account with Provider API entitlement, or use the official CLI within its supported plan.
2. After changing accounts, run `/login` again and reload the host. Existing sessions, credentials and model selections are not deleted or migrated by this change.
3. Retry a small request and check `/commandcode-status`. There is no switch to re-enable internal generation. Do not use alternate endpoint overrides to bypass plan restrictions.

GOAT/Provider accounts with API entitlement continue to use the same documented inference endpoints. Quota reporting is unchanged. This is a breaking-change proposal, not a claim that the version on npm already includes it.

## Install

```sh
pi install npm:pi-commandcode-provider
```

Start or reload pi, then authenticate:

```txt
/login
```

Select **Use a subscription**, then **Command Code**. Choose browser login or paste an API key, then select a model with `/model`.

## Oh My Pi

Install the same package in [Oh My Pi](https://github.com/can1357/oh-my-pi):

```sh
omp plugin install pi-commandcode-provider
```

Restart OMP or run `/reload`, then use `/login` and select **Use a subscription** followed by **Command Code**.

## Authentication

### Login dialog

Run `/login` in pi or OMP. Select **Use a subscription**, then **Command Code**. Press Enter for browser login, type `key` to open a paste prompt, or paste the API key directly. The selected credential is stored in the host's auth file.

<img width="1520" height="554" alt="Select Command Code in pi's login dialog" src="https://github.com/user-attachments/assets/071e929a-6f49-4803-bfec-7a31368fb12a" />

If automatic transfer from the browser fails, copy the API key shown by Command Code and paste it into the terminal prompt.

On Oh My Pi, `/login` stores those credentials in OMP's credential store and chat uses them directly. If chat still returns `401 Invalid 'Authorization' header`, restart OMP after `/login` and confirm `/commandcode-quota` shows your account.

### Environment variable

```sh
export COMMAND_CODE_API_KEY="user_..."
```

### Auth file

The provider also reads existing credentials from:

- `~/.commandcode/auth.json`
- `~/.pi/agent/auth.json`
- `~/.omp/agent/auth.json`

Supported examples:

```json
{
  "apiKey": "user_..."
}
```

```json
{
  "command-code": {
    "type": "api",
    "key": "user_..."
  }
}
```

```json
{
  "commandcode": "user_..."
}
```

## Usage

Open `/model` and select one of the models provided by Command Code. Model availability changes over time and is refreshed from the Provider API when the extension loads.

Other extensions that stream with the active Command Code model, such as background agents or memory workers, use the same connection and the same credentials as the chat, so their requests count against your Command Code usage.

### Endpoint selection

The Provider API serves models on different wires, and `/provider/v1/models` advertises the routes each model answers on through its `supported_endpoints` field. The provider maps that to the matching wire:

- Claude models answer on `/provider/v1/messages` only.
- Models advertising `/responses` use the OpenAI Responses wire on `/provider/v1/responses`.
- Every other model uses OpenAI Chat Completions on `/provider/v1/chat/completions`.

A model whose catalog entry omits `supported_endpoints` keeps Chat Completions, which every non-Claude model serves, so discovery keeps working when the field is absent. The selection is applied per model, so a catalog that mixes wires streams each model correctly.

### Reasoning support

Reasoning capability and selectable effort levels follow the official CLI catalog independently. Models can therefore be marked as reasoning-capable even when Command Code chooses their depth automatically. Models with explicit effort support register a model-specific `thinkingLevelMap`, so pi and OMP expose only valid levels. For a few reasoning models the CLI catalog ships no effort levels although the endpoint accepts `reasoning_effort`; `src/commandcode-catalog-overrides.ts` adds a manual level set for those on top of the generated catalog (currently empty because upstream publishes every level). The catalog sync removes an override as soon as upstream publishes its own levels. Pi's native OpenAI- and Anthropic-compatible providers translate the selected level for Provider API accounts.

List Command Code models from the terminal:

```sh
pi --list-models commandcode
```

In OMP, use:

```sh
omp models
```

For non-interactive OMP requests, use a provider-qualified model ID shown by `omp models`. For example:

```sh
omp -p "hello" --model commandcode/deepseek/deepseek-v4-flash
```

## Model discovery and offline behavior

The provider fetches the current model catalog from:

```txt
https://api.commandcode.ai/provider/v1/models
```

The last successful catalog is cached at `<agent-dir>/commandcode-models.json`. For pi this is `~/.pi/agent/commandcode-models.json` by default. Compatible hosts such as OMP use their own agent directory.

When a valid cache exists, the provider registers the cached catalog immediately and refreshes it from the endpoint in the background, so startup does not wait for the network. The refreshed catalog replaces the cached one as soon as it arrives; `/commandcode-status` reports `source: cache` until then. If the endpoint is temporarily unavailable, the cached catalog stays active. On a first start without a cache, the provider waits for the live catalog; if that fails offline, pi still loads, but Command Code models remain unavailable until the connection is restored and `/commandcode-refresh` succeeds.

While pi is running, use these provider commands without restarting:

- `/commandcode-refresh` fetches and re-registers the current model catalog. Overlapping refreshes are coalesced, and a failed refresh keeps the last valid catalog active.
- `/commandcode-status` shows redacted discovery diagnostics, including the source, model count, timestamps, cache path, endpoint, and warning. If a Responses reasoning event has an unsupported shape, a separate stream warning remains visible until the extension is reloaded or the host restarts. The event is preserved unchanged; no reasoning text is included in the warning.
- `/commandcode-quota` shows your Command Code account usage and quota in a dashboard-style layout: credits remaining and used with a percentage, monthly/purchased/free sources, the current plan, available usage totals, the API key name, and the 5-hour and weekly usage windows.

The `commandcode-quota` command reads from the Command Code alpha usage endpoints (the same ones the `cmd` CLI `/usage` command uses): `whoami`, `billing/credits`, `billing/subscriptions`, and `usage/summary`. It authenticates with the same API key the provider already uses. If the command cannot reach those endpoints or an endpoint schema changes, unavailable sections are reported explicitly instead of being displayed as zero usage. Output is plain text (via `ui.notify`) so it works across pi and compatible hosts such as OMP.

On Oh My Pi the provider also registers an OMP usage provider through the `usage` field of `pi.registerProvider`, reading the same endpoints with the same credentials. It supplies the account's 5-hour and weekly usage windows, credits remaining and used against the billing-period pool, and the current plan to the host's usage surfaces, and it follows the same rule for sections the API does not report. pi has no such field and ignores it.

Set `CMD_ZDR=1` to send Command Code's documented `x-cmd-zdr: 1` zero-data-retention header. The legacy `COMMANDCODE_ZDR=1` alias remains supported.

The following environment variables are intended for tests, local mocks, and compatible API endpoints:

- `COMMANDCODE_API_BASE`
- `COMMANDCODE_MODELS_URL`
- `COMMANDCODE_MODELS_CACHE`
- `COMMANDCODE_MODELS_TIMEOUT_MS` (defaults to 10 seconds; invalid or non-positive values use the default)

## Image input

The provider advertises image input only for models marked with the `image` input modality in the official Command Code CLI model catalog. The capability snapshot currently follows `command-code@1.82.4`; unknown models default to text-only until their upstream metadata is reviewed. A daily GitHub Actions job synchronizes the CLI version, image capabilities, reasoning flags, reasoning efforts, and model-specific output limits with the latest published CLI package, also dropping manual effort overrides that upstream has published itself, and opens or updates a reviewable pull request when they change. Pricing remains manually reviewed because temporary promotions and long-context tiers require explicit review.

For vision-capable models, Pi's native provider adapters forward image blocks from user messages and tool results using the documented OpenAI or Anthropic message schema. Unknown and text-only models remain marked text-only in Pi.

The native host adapter uses the registered model's input capabilities on the Provider API. A host model override can advertise image support before the catalog catches up, but cannot grant missing upstream model or plan access.

## Pricing display

The Command Code Provider API does not currently include prices in its model catalog. This extension therefore keeps a static table for models with known prices so pi and OMP can display estimated request costs. DeepSeek V4 uses time-dependent rates: the extension applies the documented 2x peak rates on weekdays from 01:00-04:00 and 06:00-10:00 UTC, and off-peak rates at all other times, including the entire weekend. These rates are selected at request time on the Provider API path.

Models missing from that table display zero cost in pi. This does **not** mean that Command Code will bill the request at zero. The Command Code Usage page remains authoritative for each request. Check the current [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits) before relying on the displayed value.

A read-only companion check, `npm run check:commandcode-pricing`, compares the live Provider API catalog and the official pricing page with the static table. It never writes prices: exit code `0` means every compared rate matches, `1` means drift or an expired promotion needs manual review, and `2` means the price could not be checked. The daily catalog workflow and applicable pull requests publish the Markdown report to the GitHub Actions summary. The pricing page has no public pricing API, so the check parses its private Next.js Flight payload; if that format changes the check fails loudly instead of reporting a false pass, and prices stay manually reviewed.

## Update and remove

Update installed pi packages:

```sh
pi update --extensions
```

Remove the provider:

```sh
pi remove npm:pi-commandcode-provider
```

For OMP:

```sh
# Update
omp plugin install pi-commandcode-provider --force

# Remove
omp plugin uninstall pi-commandcode-provider
```

## Development

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

### Live transport tests

Keep GOAT- and Provider-plan test keys in separate secret-manager entries. Pass them through protected files so the keys do not enter shell history:

```sh
COMMANDCODE_E2E_GOAT_API_KEY_FILE=/path/to/goat-key \
  npm run test:e2e:live:goat

COMMANDCODE_E2E_PROVIDER_API_KEY_FILE=/path/to/provider-key \
  npm run test:e2e:live:provider

COMMANDCODE_E2E_PROVIDER_API_KEY_FILE=/path/to/provider-key \
COMMANDCODE_E2E_GOAT_API_KEY_FILE=/path/to/goat-key \
  npm run test:e2e:live:all
```

Each profile runs with an isolated Pi agent directory and asserts transport selection, reasoning across turns, quota plan identity, abort handling, tool calls, and the packed npm artifact. Both profiles must select `provider`; GOAT also completes a live vision request. Go entitlement denial and the absence of any internal generation request are covered by mock Pi/OMP tests, not paid live probes. The profile-specific `*_API_KEY` environment variables are also supported for CI secrets, but key files are preferred for local use.

The Provider profile defaults to DeepSeek V4 Flash; GOAT defaults to Grok 4.6 because its Provider API stream exposes reasoning consistently across consecutive turns. Override them with `COMMANDCODE_E2E_GOAT_MODEL` or `COMMANDCODE_E2E_PROVIDER_MODEL`. The GOAT vision phase defaults to GPT-5.6 Luna and can be overridden with `COMMANDCODE_E2E_GOAT_VISION_MODEL`. A successful live Anthropic `/provider/v1/messages` test requires a paid account whose plan includes the selected Claude model.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and tests. See [RELEASE.md](RELEASE.md) for the release process.

## Maintainers

- [@patlux](https://github.com/patlux)
- [@pierreraby](https://github.com/pierreraby)
- [@karaaslanz](https://github.com/karaaslanz)

## License

MIT
