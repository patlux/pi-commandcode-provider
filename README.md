# pi-commandcode-provider

A [pi](https://github.com/badlogic/pi-mono) custom provider that connects pi to the [Command Code](https://commandcode.ai) API.

> **Disclaimer:** This is an unofficial, community-maintained package. I am not affiliated with, endorsed by, or connected to Command Code in any way. This provider simply forwards requests to the public Command Code API using your own API key.

> **Note:** This package only provides a model _provider_. It does **not** include an API key. You must bring your own Command Code API key or subscription.

> 💰 **Current offers:** Command Code offers [4× usage of DeepSeek V4 Pro](https://commandcode.ai/docs/resources/pricing-limits#deepseek-v4-pro-4x-usage) and [2× usage of Qwen 3.7 Max](https://commandcode.ai/docs/resources/pricing-limits#qwen-3.7-max-2x-usage).

## Models

Models are fetched live from Command Code's Provider API at startup, so new models like Qwen 3.7 Max show up without a package release.

You can list the current Command Code models with:

```sh
pi -e index.ts --list-models
```

## Thinking levels

Each model registers a `thinkingLevelMap` built from its supported reasoning efforts, so pi/OMP expose exactly the tiers the model supports — and forward the selected level as `reasoning_effort` in the `/alpha/generate` request body.

**Per-model efforts.** The supported levels vary by model (e.g. DeepSeek V4 Flash supports only `high` and `max`; Claude Sonnet 5 supports `low` through `max`). These are extracted from the official command-code CLI catalog (`MODEL_EFFORTS` in `src/models.ts`), because the Provider API exposes no effort metadata. Selecting an unsupported tier is hidden from the UI. Models absent from the table get no map, preserving pi's default `off` → `high` tiers.

**Real passthrough.** The selected thinking level is sent to Command Code as `params.reasoning_effort` (e.g. `"max"`), matching the official CLI. The `off` level has no upstream equivalent and is omitted, so the model's default reasoning applies.

## Install

```sh
pi install npm:pi-commandcode-provider
```

Or shorthand:

```sh
pi install pi-commandcode-provider
```

Then reload pi:

```txt
/reload
```

### Oh My Pi

```sh
omp plugin install pi-commandcode-provider
```

Then restart OMP or run:

```txt
/reload
```

## Setup

Set your Command Code API key using one of these methods:

### 1. Browser login (recommended)

In pi, run:

```txt
/login
```

Then select **Command Code** from the provider list.

<img width="1520" height="554" alt="image" src="https://github.com/user-attachments/assets/071e929a-6f49-4803-bfec-7a31368fb12a" />

This opens Command Code in your browser and stores the returned API key in pi's auth file. If the browser shows "Copy your API key" because automatic transfer failed, copy that key and paste it into the pi terminal prompt.

> Note: `/login commandcode` is not supported by pi currently; use interactive `/login` and select Command Code.

### 2. Environment variable

```sh
export COMMANDCODE_API_KEY="user_..."
```

### 3. Auth file

Create `~/.commandcode/auth.json`:

```json
{
  "apiKey": "user_..."
}
```

The official Command Code CLI auth shape is also supported:

```json
{
  "command-code": {
    "type": "api",
    "key": "user_..."
  }
}
```

Or use a pi/OMP auth file at `~/.pi/agent/auth.json` or `~/.omp/agent/auth.json`:

```json
{
  "commandcode": "user_..."
}
```

## Usage

After installing and setting your API key, select a Command Code model in pi:

```txt
/model deepseek/deepseek-v4-flash
```

Any query will then use the Command Code API. You can list available models:

```sh
pi -e index.ts --list-models   # or /models within pi
omp -e index.ts --list-models
```

In OMP, use the provider-qualified model name:

```sh
omp -p "hello" --model commandcode/deepseek/deepseek-v4-flash
```

OMP currently resolves `--provider commandcode --model ...` before extension providers are loaded, so prefer `--model commandcode/<model-id>`. <!-- TODO: remove this note once OMP fixes provider resolution order for extension-loaded providers -->

## Model discovery

On startup, the provider fetches:

```txt
https://api.commandcode.ai/provider/v1/models
```

The last successfully fetched catalog is cached at `<agent-dir>/commandcode-models.json` (`~/.pi/agent/commandcode-models.json` by default). The agent directory follows pi's `PI_CODING_AGENT_DIR` setting, so compatible hosts such as OMP keep the cache in their own agent directory. If model discovery is temporarily unavailable, the provider uses this cached catalog so previously discovered Command Code models remain selectable. On a first offline start without a cache, pi still loads, but Command Code models remain unavailable until the connection is restored and `/reload` succeeds.

For tests or local mocks, override the endpoint with `COMMANDCODE_MODELS_URL` and the cache file with `COMMANDCODE_MODELS_CACHE`.

## Pricing

Command Code does not yet expose model pricing through its Provider API. The provider ships a static cost table (`MODEL_COSTS` in `index.ts`) for known models so that pi can display per-model pricing.

- Models present in `MODEL_COSTS` show their real per-million-token rates (including promotional deals like the DeepSeek V4 Pro 4× discount and Qwen 3.7 Max 2× discount).
- Models **not** in the table fall back to zero cost. When the Provider API adds a `cost` field, the static table can be removed.

To add or update a price, edit the `MODEL_COSTS` record in `index.ts` and update the corresponding test in `tests/test-pricing.ts`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, PR expectations, and commit message rules.

## Release

See [RELEASE.md](RELEASE.md) for the prerelease, npm smoke-test, stable publish, git tag, and GitHub follow-up checklist.

## License

MIT
