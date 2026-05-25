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

Or use pi's auth file at `~/.pi/agent/auth.json`:

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

Any query will then use the Command Code API. You can list available models within pi:

```txt
/models
```

<<<<<<< HEAD
## Model discovery
=======
## Update models

The model list (`models.json`) is extracted from the [command-code](https://www.npmjs.com/package/command-code) npm package's dist file. When Command Code releases a new version with updated models, regenerate it:

```sh
npm run extract-models
```

This runs `scripts/extract-models.ts`, which:

1. Downloads the latest `command-code` tarball from npm (`npm pack command-code`)
2. Parses the minified `dist/index.mjs` to extract provider definitions, model metadata, and pricing
3. Fills in `contextWindow` and `maxOutputTokens` with sensible defaults where the CLI omits them
4. Writes the result to `models.json`

To use a specific version or local dist file:

```sh
npx tsx scripts/extract-models.ts /path/to/command-code/dist/index.mjs
```

`models.json` is committed to the repo and included in the npm package.

## Publish
>>>>>>> 960d0d1 (feat: extract models from command-code dist, load via models.json)

On startup, the provider fetches:

```txt
https://api.commandcode.ai/provider/v1/models
```

For tests or local mocks, override it with `COMMANDCODE_MODELS_URL`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, PR expectations, and commit message rules.

## Release

See [RELEASE.md](RELEASE.md) for the prerelease, npm smoke-test, stable publish, git tag, and GitHub follow-up checklist.

## License

MIT
