import type { CommandCodeModel, LoadCommandCodeModelsResult } from "./models.ts"

export interface CommandCodeUi {
  notify(message: string, type?: "info" | "warning" | "error"): void
}

export interface CommandCodeCommandContext {
  ui: CommandCodeUi
  waitForIdle?: () => Promise<void>
}

export interface CommandCodeRuntimeApi<
  TProviderConfig,
  TContext extends CommandCodeCommandContext,
> {
  registerProvider(name: string, config: TProviderConfig): void
  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: TContext) => Promise<void>
    },
  ): void
}

export interface CommandCodeRuntimeOptions<TProviderConfig> {
  endpoint: string
  cachePath: string
  loadModels: (signal: AbortSignal) => Promise<LoadCommandCodeModelsResult>
  /** Cached catalog only; resolves to an empty list when no valid cache exists. */
  loadCachedModels: () => Promise<readonly CommandCodeModel[]>
  createProviderConfig: (models: readonly CommandCodeModel[]) => TProviderConfig
  getTransport?: () => "unknown" | "provider" | "generate"
  now?: () => number
  logWarning?: (message: string) => void
}

export interface CommandCodeRuntimeStatus {
  transport: "unknown" | "provider" | "generate"
  source: LoadCommandCodeModelsResult["source"]
  modelCount: number
  lastSuccess?: number
  lastAttempt?: number
  cachePath: string
  endpoint: string
  warning?: string
  refreshing: boolean
}

export interface CommandCodeRefreshResult {
  refreshed: boolean
  source: CommandCodeRuntimeStatus["source"]
  modelCount: number
  warning?: string
}

const REDACTED = "[redacted]"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return REDACTED
  }
}

export function redactDiagnosticText(value: string): string {
  const redactedUrls = value.replace(/https?:\/\/[^\s)]+/gi, (match) => redactUrl(match))
  return redactedUrls
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:user|cc)_[A-Za-z0-9_-]{8,}\b/gi, REDACTED)
    .replace(/\b(?:api[-_ ]?key|token|secret|password)\s*[=:]\s*[^\s,;)]+/gi, (match) => {
      const separator = match.match(/\s*[=:]\s*/)?.[0] ?? "="
      return `${match.slice(0, match.indexOf(separator))}${separator}${REDACTED}`
    })
}

export function redactEndpoint(value: string): string {
  return redactUrl(value)
}

function formatTimestamp(timestamp: number | undefined): string {
  return timestamp === undefined ? "never" : new Date(timestamp).toISOString()
}

export function formatCommandCodeStatus(status: CommandCodeRuntimeStatus): string {
  const lines = [
    `transport: ${status.transport}`,
    `source: ${status.source}`,
    `model count: ${status.modelCount}`,
    `last success: ${formatTimestamp(status.lastSuccess)}`,
    `last attempt: ${formatTimestamp(status.lastAttempt)}`,
    `cache path: ${status.cachePath}`,
    `endpoint: ${redactEndpoint(status.endpoint)}`,
    `refresh: ${status.refreshing ? "in progress" : "idle"}`,
  ]

  lines.push(`warning: ${status.warning ? redactDiagnosticText(status.warning) : "none"}`)
  return lines.join("\n")
}

export class CommandCodeRuntime<TProviderConfig, TContext extends CommandCodeCommandContext> {
  private readonly now: () => number
  private readonly logWarning: (message: string) => void
  private status: CommandCodeRuntimeStatus
  private providerRegistered = false
  private refreshPromise: Promise<CommandCodeRefreshResult> | undefined
  private readonly shutdown = new AbortController()

  constructor(
    private readonly pi: CommandCodeRuntimeApi<TProviderConfig, TContext>,
    private readonly options: CommandCodeRuntimeOptions<TProviderConfig>,
  ) {
    this.now = options.now ?? Date.now
    // Direct console output corrupts the host TUI; warnings remain in /commandcode-status.
    this.logWarning = options.logWarning ?? (() => {})
    const initialStatus: CommandCodeRuntimeStatus = {
      transport: "unknown",
      source: "empty",
      modelCount: 0,
      cachePath: options.cachePath,
      endpoint: options.endpoint,
      refreshing: false,
    }
    this.status = { ...initialStatus }
  }

  getStatus(): CommandCodeRuntimeStatus {
    return {
      ...this.status,
      transport: this.options.getTransport?.() ?? "unknown",
    }
  }

  /**
   * Registers the cached catalog immediately and refreshes it in the
   * background so host startup does not wait for the network. Without a
   * valid cache the live refresh is awaited so models are available at once.
   */
  async initialize(): Promise<void> {
    this.registerCommands()

    const cached = await this.options.loadCachedModels()
    if (cached.length === 0) {
      await this.refresh()
      return
    }

    this.pi.registerProvider("commandcode", this.options.createProviderConfig(cached))
    this.providerRegistered = true
    this.status = {
      ...this.status,
      source: "cache",
      modelCount: cached.length,
      lastSuccess: this.now(),
    }
    void this.refresh()
  }

  /** Aborts any background refresh so a stopping host does not wait for the network. */
  dispose(): void {
    this.shutdown.abort(new Error("Command Code provider shut down"))
  }

  refresh(): Promise<CommandCodeRefreshResult> {
    if (this.refreshPromise) return this.refreshPromise

    const refreshPromise = this.refreshCatalog().finally(() => {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = undefined
    })
    this.refreshPromise = refreshPromise
    return refreshPromise
  }

  private async refreshCatalog(): Promise<CommandCodeRefreshResult> {
    this.status = {
      ...this.status,
      lastAttempt: this.now(),
      refreshing: true,
    }

    try {
      const loaded = await this.options.loadModels(this.shutdown.signal)
      const warning = loaded.warning ? redactDiagnosticText(loaded.warning) : undefined

      const shouldRegister =
        !this.providerRegistered ||
        loaded.source === "live" ||
        (this.status.modelCount === 0 && loaded.models.length > 0)

      if (shouldRegister) {
        this.pi.registerProvider("commandcode", this.options.createProviderConfig(loaded.models))
        this.providerRegistered = true

        if (loaded.models.length === 0) {
          const preservedWarning = warning ?? "Model catalog refresh returned no models"
          this.status = {
            ...this.status,
            source: loaded.source,
            modelCount: 0,
            warning: preservedWarning,
            refreshing: false,
          }
          this.warn(preservedWarning)
          return {
            refreshed: false,
            source: loaded.source,
            modelCount: 0,
            warning: preservedWarning,
          }
        }

        this.status = {
          ...this.status,
          source: loaded.source,
          modelCount: loaded.models.length,
          lastSuccess: this.now(),
          warning,
          refreshing: false,
        }
        if (warning) this.warn(warning)
        return {
          refreshed: true,
          source: loaded.source,
          modelCount: loaded.models.length,
          warning,
        }
      }

      const preservedWarning = warning ?? "Model catalog refresh returned no models"
      this.status = {
        ...this.status,
        warning: preservedWarning,
        refreshing: false,
      }
      this.warn(preservedWarning)
      return {
        refreshed: false,
        source: this.status.source,
        modelCount: this.status.modelCount,
        warning: preservedWarning,
      }
    } catch (error) {
      if (this.shutdown.signal.aborted) {
        this.status = { ...this.status, refreshing: false }
        return {
          refreshed: false,
          source: this.status.source,
          modelCount: this.status.modelCount,
        }
      }
      const warning = redactDiagnosticText(
        `Could not refresh the Command Code model catalog: ${errorMessage(error)}`,
      )
      this.status = {
        ...this.status,
        warning,
        refreshing: false,
      }
      this.warn(warning)
      return {
        refreshed: false,
        source: this.status.source,
        modelCount: this.status.modelCount,
        warning,
      }
    }
  }

  private warn(message: string): void {
    try {
      this.logWarning(redactDiagnosticText(message))
    } catch {
      // Diagnostics must never make a catalog refresh fail.
    }
  }

  private registerCommands(): void {
    this.pi.registerCommand("commandcode-refresh", {
      description: "Refresh the Command Code model catalog",
      handler: async (_args, ctx) => {
        await ctx.waitForIdle?.()
        const result = await this.refresh()
        if (result.refreshed) {
          ctx.ui.notify(
            `Command Code model catalog refreshed (${result.modelCount} models from ${result.source}).`,
            "info",
          )
        } else {
          ctx.ui.notify(
            `Command Code model catalog unchanged (${result.modelCount} models remain available).${result.warning ? ` ${result.warning}` : ""}`,
            "warning",
          )
        }
      },
    })

    this.pi.registerCommand("commandcode-status", {
      description: "Show redacted Command Code provider diagnostics",
      handler: async (_args, ctx) => {
        const status = this.getStatus()
        ctx.ui.notify(formatCommandCodeStatus(status), status.warning ? "warning" : "info")
      },
    })
  }
}

export function createCommandCodeRuntime<
  TProviderConfig,
  TContext extends CommandCodeCommandContext,
>(
  pi: CommandCodeRuntimeApi<TProviderConfig, TContext>,
  options: CommandCodeRuntimeOptions<TProviderConfig>,
): CommandCodeRuntime<TProviderConfig, TContext> {
  return new CommandCodeRuntime(pi, options)
}
