# pi-commandcode-provider

[![CI](https://github.com/patlux/pi-commandcode-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/patlux/pi-commandcode-provider/actions/workflows/ci.yml)
[![Memory benchmark](https://github.com/patlux/pi-commandcode-provider/actions/workflows/memory-benchmark.yml/badge.svg)](https://github.com/patlux/pi-commandcode-provider/actions/workflows/memory-benchmark.yml)

A custom provider for [pi](https://github.com/earendil-works/pi) that connects to the [Command Code](https://commandcode.ai) Provider API.

> **Disclaimer:** This is an unofficial, community-maintained integration. It is not affiliated with, endorsed by, or supported by Command Code. You need your own Command Code account and API key or subscription. Command Code's terms, availability, and pricing apply.

## Install

```sh
pi install npm:pi-commandcode-provider
```

Start or reload pi, then authenticate:

```txt
/login
```

Select **Use a subscription**, then **Command Code**. Complete the browser flow and choose a model with `/model`.

## Oh My Pi

Install the same package in [Oh My Pi](https://github.com/can1357/oh-my-pi):

```sh
omp plugin install pi-commandcode-provider
```

Restart OMP or run `/reload`, then use `/login` and select **Use a subscription** followed by **Command Code**.

## Authentication

### Browser login

Run `/login` in pi or OMP. Select **Use a subscription**, then **Command Code**. The browser flow stores the returned credential in the host's auth file.

<img width="1520" height="554" alt="Select Command Code in pi's login dialog" src="https://github.com/user-attachments/assets/071e929a-6f49-4803-bfec-7a31368fb12a" />

If automatic transfer from the browser fails, copy the API key shown by Command Code and paste it into the terminal prompt.

### Environment variable

```sh
export COMMANDCODE_API_KEY="user_..."
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

## Thinking and images

pi's thinking level is forwarded to the Command Code API as `params.thinking = { type: "enabled" }` whenever the selected model supports reasoning and the level is not `off`. Without this the API decides on its own whether to emit a reasoning trace, which makes traces appear and disappear depending on conversation history.

Reasoning blocks from previous assistant turns are not echoed back to the API. The Command Code backend treats past reasoning as the answer to later follow-up questions and stops producing new reasoning, so the provider sends only text and tool calls from history while still showing the current turn's thinking live.

Image content blocks in user messages and image attachments on tool results are converted to base64 image parts the `alpha/generate` API accepts, so pasted screenshots and image tool results are sent as user-role images.

## Model discovery and offline behavior

The provider fetches the current model catalog from:

```txt
https://api.commandcode.ai/provider/v1/models
```

The last successful catalog is cached at `<agent-dir>/commandcode-models.json`. For pi this is `~/.pi/agent/commandcode-models.json` by default. Compatible hosts such as OMP use their own agent directory.

If the endpoint is temporarily unavailable, the provider uses the cached catalog. On a first offline start without a cache, pi still loads, but Command Code models remain unavailable until the connection is restored and `/reload` succeeds.

The following environment variables are intended for tests, local mocks, and compatible API endpoints:

- `COMMANDCODE_API_BASE`
- `COMMANDCODE_MODELS_URL`
- `COMMANDCODE_MODELS_CACHE`

## Pricing display

The Command Code Provider API does not currently include prices in its model catalog. This extension therefore keeps a static table for models with known prices so pi can display estimated request costs.

Models missing from that table display zero cost in pi. This does **not** mean that Command Code will bill the request at zero. Check the current [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits) before relying on the displayed value.

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
omp plugin upgrade pi-commandcode-provider
omp plugin uninstall pi-commandcode-provider
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and tests. See [RELEASE.md](RELEASE.md) for the release process.

## License

MIT
