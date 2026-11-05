import { getConfiguredApiKey } from "./api-key.ts"
import { pickCommandCodeApiKey } from "./api-key.ts"
import { fetchCommandCodeQuota, redactValue } from "./quota.ts"
import { formatQuota } from "./quota-format.ts"

export interface QuotaCommandContext {
  waitForIdle?: () => Promise<void>
  modelRegistry?: {
    getApiKeyForProvider?: (provider: string) => Promise<string | undefined>
  }
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void
  }
}

interface QuotaCommandApi {
  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: QuotaCommandContext) => Promise<void>
    },
  ): void
}

interface RegisterQuotaCommandOptions {
  apiBase: string
  headers?: Record<string, string>
  getConfiguredKey?: () => string | undefined
  fetchQuota?: typeof fetchCommandCodeQuota
}

export function registerCommandCodeQuota(
  pi: QuotaCommandApi,
  options: RegisterQuotaCommandOptions,
): void {
  const getConfiguredKey = options.getConfiguredKey ?? getConfiguredApiKey
  const fetchQuota = options.fetchQuota ?? fetchCommandCodeQuota

  pi.registerCommand("commandcode-quota", {
    description: "Show Command Code account usage and quota",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle?.()
      const registryKey = await ctx.modelRegistry?.getApiKeyForProvider?.("commandcode")
      const apiKey = pickCommandCodeApiKey(registryKey, getConfiguredKey())
      if (!apiKey) {
        ctx.ui.notify(
          "Command Code quota requires an API key. Run /login and select Command Code, or set COMMAND_CODE_API_KEY.",
          "warning",
        )
        return
      }

      const result = await fetchQuota({
        apiKey,
        baseUrl: options.apiBase,
        extraHeaders: options.headers,
      })
      if (!result.ok) {
        ctx.ui.notify(redactValue(result.error.message), "error")
        return
      }
      ctx.ui.notify(formatQuota(result.quota), "info")
    },
  })
}
