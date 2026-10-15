import type {
  AssistantMessageEventStreamLike,
  ContextLike,
  ModelLike,
  StreamOptions,
} from "./types.ts"

export type CommandCodeTransport = "unknown" | "provider"

export const PROVIDER_ACCESS_REQUIRED =
  "Command Code Provider API access is required (403 upgrade_required). The Go plan does not include API use. Use an account/plan with documented Provider API access, then sign in again. This extension no longer falls back to the internal /alpha/generate endpoint. See https://commandcode.ai/docs/provider."

interface TransportDependencies {
  createStream: () => AssistantMessageEventStreamLike
  streamProvider: (
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ) => AssistantMessageEventStreamLike
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function isUpgradeRequired(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  try {
    const body: unknown = await response.clone().json()
    if (!isRecord(body)) return false
    const error = isRecord(body.error) ? body.error : body
    return error.code === "upgrade_required"
  } catch {
    return false
  }
}

export function createCommandCodeTransportRouter(deps: TransportDependencies) {
  let transport: CommandCodeTransport = "unknown"
  return {
    getTransport: (): CommandCodeTransport => transport,
    reset(): void {
      transport = "unknown"
    },
    stream(
      model: ModelLike,
      context: ContextLike,
      options?: StreamOptions,
    ): AssistantMessageEventStreamLike {
      transport = "provider"
      const output = deps.createStream()
      let upgradeRequired = false
      const fetchImpl = options?.fetch ?? fetch
      const providerOptions: StreamOptions = {
        ...options,
        fetch: async (input, init) => {
          const response = await fetchImpl(input, init)
          if (await isUpgradeRequired(response)) upgradeRequired = true
          return response
        },
      }
      const run = async () => {
        try {
          for await (const event of deps.streamProvider(model, context, providerOptions)) {
            if (!upgradeRequired) output.push(event)
          }
        } catch (error) {
          // Both emitted error events and rejected host iterators must yield
          // the same entitlement message, never a retry on an internal API.
          if (!upgradeRequired) throw error
        }
        if (upgradeRequired) throw new Error(PROVIDER_ACCESS_REQUIRED)
        output.end()
      }
      run().catch((error: unknown) => {
        output.push({
          type: "error",
          reason: options?.signal?.aborted ? "aborted" : "error",
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: options?.signal?.aborted ? "aborted" : "error",
            errorMessage: upgradeRequired
              ? PROVIDER_ACCESS_REQUIRED
              : error instanceof Error
                ? error.message
                : String(error),
            timestamp: Date.now(),
          },
        })
        output.end()
      })
      return output
    },
  }
}
