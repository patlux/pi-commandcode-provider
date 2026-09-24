import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createCommandCodeRuntime,
  type CommandCodeCommandContext,
  type CommandCodeRuntimeApi,
} from "../src/runtime.ts"
import type { CommandCodeModel, LoadCommandCodeModelsResult } from "../src/models.ts"

type ProviderConfig = {
  models: readonly CommandCodeModel[]
}

class ExtensionAPITestDouble implements CommandCodeRuntimeApi<ProviderConfig, CommandContext> {
  readonly providers: ProviderConfig[] = []
  readonly commands = new Map<string, (args: string, ctx: CommandContext) => Promise<void> | void>()

  registerProvider(_name: string, config: ProviderConfig): void {
    this.providers.push(config)
  }

  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: CommandContext) => Promise<void> | void
    },
  ): void {
    this.commands.set(name, options.handler)
  }
}

class CommandContext implements CommandCodeCommandContext {
  readonly notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = []
  waitForIdleCalls = 0

  readonly ui = {
    notify: (message: string, type?: "info" | "warning" | "error") => {
      this.notifications.push({ message, type })
    },
  }

  async waitForIdle(): Promise<void> {
    this.waitForIdleCalls += 1
  }
}

const FIRST_MODEL: CommandCodeModel = {
  id: "first-model",
  name: "First Model",
  api: "openai-completions",
  reasoning: true,
  contextWindow: 128_000,
  maxTokens: 16_384,
}

const SECOND_MODEL: CommandCodeModel = {
  id: "second-model",
  name: "Second Model",
  api: "openai-completions",
  reasoning: true,
  contextWindow: 256_000,
  maxTokens: 32_768,
}

function loaded(
  models: readonly CommandCodeModel[],
  source: LoadCommandCodeModelsResult["source"] = "live",
  warning?: string,
): LoadCommandCodeModelsResult {
  return warning ? { models, source, warning } : { models, source }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolvePromise: (value: T) => void = () => {}
  let rejectPromise: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

describe("Command Code runtime", () => {
  it("keeps default warning diagnostics off the console and available in status", async (t) => {
    const warn = t.mock.method(console, "warn", () => {})
    const pi = new ExtensionAPITestDouble()
    const context = new CommandContext()
    const warning =
      "Loaded the live Command Code model catalog but could not update /missing/commandcode-models.json: ENOENT"
    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models",
      cachePath: "/missing/commandcode-models.json",
      loadModels: async () => loaded([FIRST_MODEL], "live", warning),
      loadCachedModels: async () => [],
      createProviderConfig: (models) => ({ models }),
    })

    await runtime.initialize()
    await runtime.refresh()
    assert.deepEqual(pi.providers.at(-1)?.models, [FIRST_MODEL])
    assert.equal(runtime.getStatus().warning, warning)

    const statusCommand = pi.commands.get("commandcode-status")
    assert.ok(statusCommand)
    await statusCommand("", context)
    assert.equal(context.notifications.at(-1)?.type, "warning")
    assert.ok(context.notifications.at(-1)?.message.includes(warning))
    assert.equal(warn.mock.callCount(), 0)
  })

  it("registers refresh and status commands and exposes redacted state", async () => {
    const pi = new ExtensionAPITestDouble()
    const context = new CommandContext()
    let now = 1_700_000_000_000
    const firstLoad = deferred<LoadCommandCodeModelsResult>()

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models?token=user_secret_value",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: () => firstLoad.promise,
      loadCachedModels: async () => [],
      createProviderConfig: (models) => ({ models }),
      getTransport: () => "provider",
      now: () => now,
      logWarning: () => {},
    })

    const initialization = runtime.initialize()
    assert.deepEqual([...pi.commands.keys()], ["commandcode-refresh", "commandcode-status"])
    await Promise.resolve()
    assert.equal(runtime.getStatus().refreshing, true)
    assert.equal(runtime.getStatus().lastAttempt, now)

    firstLoad.resolve(loaded([FIRST_MODEL]))
    await initialization
    now += 1_000

    const statusCommand = pi.commands.get("commandcode-status")
    assert.ok(statusCommand)
    await statusCommand("", context)
    const statusMessage = context.notifications.at(-1)?.message ?? ""
    assert.match(statusMessage, /transport: provider/)
    assert.match(statusMessage, /source: live/)
    assert.match(statusMessage, /model count: 1/)
    assert.match(statusMessage, /last success:/)
    assert.match(statusMessage, /last attempt:/)
    assert.match(statusMessage, /cache path: \/tmp\/commandcode-models\.json/)
    assert.match(statusMessage, /endpoint: https:\/\/api\.commandcode\.ai\/provider\/v1\/models/)
    assert.doesNotMatch(statusMessage, /token=user_secret_value/)
    assert.doesNotMatch(statusMessage, /user_secret_value/)
  })

  it("coalesces overlapping refreshes and preserves the current catalog on failure", async () => {
    const pi = new ExtensionAPITestDouble()
    const warnings: string[] = []
    const loads = [Promise.resolve(loaded([FIRST_MODEL])), deferred<LoadCommandCodeModelsResult>()]
    let loadCount = 0

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: () => {
        const next = loads[loadCount]
        loadCount += 1
        if (!next) throw new Error("unexpected refresh")
        return next instanceof Promise ? next : next.promise
      },
      loadCachedModels: async () => [],
      createProviderConfig: (models) => ({ models }),
      logWarning: (warning) => warnings.push(warning),
    })

    await runtime.initialize()
    assert.equal(pi.providers.length, 1)
    assert.deepEqual(pi.providers[0]?.models, [FIRST_MODEL])

    const pending = loads[1]
    assert.ok(!(pending instanceof Promise))
    const firstRefresh = runtime.refresh()
    const secondRefresh = runtime.refresh()
    assert.strictEqual(firstRefresh, secondRefresh)
    assert.equal(runtime.getStatus().refreshing, true)

    pending.reject(new Error("request failed with apiKey=user_secret_value"))
    const result = await firstRefresh

    assert.equal(result.refreshed, false)
    assert.equal(result.modelCount, 1)
    assert.equal(runtime.getStatus().modelCount, 1)
    assert.equal(runtime.getStatus().source, "live")
    assert.equal(pi.providers.length, 1)
    assert.equal(runtime.getStatus().refreshing, false)
    assert.match(runtime.getStatus().warning ?? "", /Could not refresh/)
    assert.doesNotMatch(runtime.getStatus().warning ?? "", /user_secret_value/)
    assert.doesNotMatch(warnings.join("\n"), /user_secret_value/)
  })

  it("runs the refresh command and reports the updated catalog", async () => {
    const pi = new ExtensionAPITestDouble()
    const context = new CommandContext()
    const results = [
      Promise.resolve(loaded([FIRST_MODEL])),
      Promise.resolve(loaded([FIRST_MODEL, SECOND_MODEL])),
    ]
    let index = 0

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: () => {
        const result = results[index]
        index += 1
        if (!result) throw new Error("unexpected refresh")
        return result
      },
      loadCachedModels: async () => [],
      createProviderConfig: (models) => ({ models }),
      logWarning: () => {},
    })

    await runtime.initialize()
    const refreshCommand = pi.commands.get("commandcode-refresh")
    assert.ok(refreshCommand)
    await refreshCommand("", context)

    assert.equal(context.waitForIdleCalls, 1)
    assert.equal(context.notifications.at(-1)?.type, "info")
    assert.match(context.notifications.at(-1)?.message ?? "", /2 models from live/)
    assert.deepEqual(pi.providers.at(-1)?.models, [FIRST_MODEL, SECOND_MODEL])
  })

  it("registers the cached catalog immediately and refreshes it in the background", async () => {
    const pi = new ExtensionAPITestDouble()
    const liveLoad = deferred<LoadCommandCodeModelsResult>()
    let now = 1_700_000_000_000

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: () => liveLoad.promise,
      loadCachedModels: async () => [FIRST_MODEL],
      createProviderConfig: (models) => ({ models }),
      now: () => now,
      logWarning: () => {},
    })

    await runtime.initialize()
    assert.equal(pi.providers.length, 1)
    assert.deepEqual(pi.providers[0]?.models, [FIRST_MODEL])
    assert.equal(runtime.getStatus().source, "cache")
    assert.equal(runtime.getStatus().modelCount, 1)
    assert.equal(runtime.getStatus().refreshing, true)

    now += 1_000
    liveLoad.resolve(loaded([FIRST_MODEL, SECOND_MODEL]))
    await runtime.refresh()
    assert.equal(pi.providers.length, 2)
    assert.deepEqual(pi.providers[1]?.models, [FIRST_MODEL, SECOND_MODEL])
    assert.equal(runtime.getStatus().source, "live")
    assert.equal(runtime.getStatus().modelCount, 2)
    assert.equal(runtime.getStatus().refreshing, false)
  })

  it("keeps the cached catalog when the background refresh fails", async () => {
    const pi = new ExtensionAPITestDouble()
    const warnings: string[] = []

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: async () => {
        throw new Error("offline")
      },
      loadCachedModels: async () => [FIRST_MODEL],
      createProviderConfig: (models) => ({ models }),
      logWarning: (message) => warnings.push(message),
    })

    await runtime.initialize()
    await runtime.refresh()
    assert.equal(pi.providers.length, 1)
    assert.deepEqual(pi.providers[0]?.models, [FIRST_MODEL])
    assert.equal(runtime.getStatus().source, "cache")
    assert.equal(runtime.getStatus().modelCount, 1)
    assert.match(runtime.getStatus().warning ?? "", /offline/)
    assert.equal(warnings.length, 1)
  })

  it("aborts the background refresh on dispose without reporting a warning", async () => {
    const pi = new ExtensionAPITestDouble()
    const warnings: string[] = []
    let refreshSignal: AbortSignal | undefined

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: (signal) =>
        new Promise((_resolve, reject) => {
          refreshSignal = signal
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
      loadCachedModels: async () => [FIRST_MODEL],
      createProviderConfig: (models) => ({ models }),
      logWarning: (message) => warnings.push(message),
    })

    await runtime.initialize()
    const pending = runtime.refresh()
    assert.equal(refreshSignal?.aborted, false)

    runtime.dispose()
    const result = await pending
    assert.equal(refreshSignal?.aborted, true)
    assert.equal(result.refreshed, false)
    assert.equal(runtime.getStatus().refreshing, false)
    assert.equal(runtime.getStatus().warning, undefined)
    assert.deepEqual(warnings, [])
    assert.deepEqual(pi.providers[0]?.models, [FIRST_MODEL])
  })

  it("awaits the live catalog when no cache exists", async () => {
    const pi = new ExtensionAPITestDouble()
    const liveLoad = deferred<LoadCommandCodeModelsResult>()

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: () => liveLoad.promise,
      loadCachedModels: async () => [],
      createProviderConfig: (models) => ({ models }),
      logWarning: () => {},
    })

    let initialized = false
    const initialization = runtime.initialize().then(() => {
      initialized = true
    })
    await Promise.resolve()
    assert.equal(pi.providers.length, 0)
    assert.equal(initialized, false)

    liveLoad.resolve(loaded([FIRST_MODEL]))
    await initialization
    assert.equal(initialized, true)
    assert.deepEqual(pi.providers[0]?.models, [FIRST_MODEL])
    assert.equal(runtime.getStatus().source, "live")
  })

  it("installs a cached catalog after an initially empty start", async () => {
    const pi = new ExtensionAPITestDouble()
    const results = [
      Promise.resolve(loaded([], "empty", "offline")),
      Promise.resolve(loaded([SECOND_MODEL], "cache")),
    ]
    let index = 0

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: () => {
        const result = results[index]
        index += 1
        if (!result) throw new Error("unexpected refresh")
        return result
      },
      loadCachedModels: async () => [],
      createProviderConfig: (models) => ({ models }),
      logWarning: () => {},
    })

    await runtime.initialize()
    assert.equal(pi.providers.length, 1)
    assert.deepEqual(pi.providers[0]?.models, [])

    const result = await runtime.refresh()
    assert.equal(result.refreshed, true)
    assert.equal(result.source, "cache")
    assert.deepEqual(pi.providers.at(-1)?.models, [SECOND_MODEL])
    assert.equal(runtime.getStatus().modelCount, 1)
  })

  it("does not replace an existing provider with an empty failed catalog", async () => {
    const pi = new ExtensionAPITestDouble()
    const results = [
      Promise.resolve(loaded([FIRST_MODEL])),
      Promise.resolve(loaded([], "cache", "No valid catalog is available at /private/cache")),
      Promise.resolve(loaded([SECOND_MODEL])),
    ]
    let index = 0

    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "http://127.0.0.1:1234/provider/v1/models",
      cachePath: "/private/cache",
      loadModels: () => {
        const result = results[index]
        index += 1
        if (!result) throw new Error("unexpected refresh")
        return result
      },
      loadCachedModels: async () => [],
      createProviderConfig: (models) => ({ models }),
      logWarning: () => {},
    })

    await runtime.initialize()
    const refreshResult = await runtime.refresh()
    assert.equal(refreshResult.refreshed, false)
    assert.equal(pi.providers.length, 1)
    assert.deepEqual(pi.providers[0]?.models, [FIRST_MODEL])
    assert.equal(runtime.getStatus().modelCount, 1)
    assert.equal(runtime.getStatus().source, "live")

    await runtime.refresh()
    assert.equal(pi.providers.length, 2)
    assert.deepEqual(pi.providers[1]?.models, [SECOND_MODEL])
  })

  it("reports a failed initial refresh without leaking diagnostics", async () => {
    const pi = new ExtensionAPITestDouble()
    const context = new CommandContext()
    const runtime = createCommandCodeRuntime(pi, {
      endpoint: "https://api.commandcode.ai/provider/v1/models?api_key=user_initial_secret",
      cachePath: "/tmp/commandcode-models.json",
      loadModels: async () => {
        throw new Error("offline; api_key=user_initial_secret")
      },
      loadCachedModels: async () => [],
      createProviderConfig: (models) => ({ models }),
      logWarning: () => {},
    })

    await runtime.initialize()
    const statusCommand = pi.commands.get("commandcode-status")
    assert.ok(statusCommand)
    await statusCommand("", context)
    const message = context.notifications.at(-1)?.message ?? ""
    assert.match(message, /source: empty/)
    assert.match(message, /model count: 0/)
    assert.match(message, /warning:/)
    assert.doesNotMatch(message, /user_initial_secret/)
  })
})
