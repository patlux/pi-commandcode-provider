import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  ContextLike,
  ModelLike,
  StreamOptions,
} from "./types.ts"

export type CommandCodeTransport = "unknown" | "provider" | "generate"

interface TransportDependencies {
  createStream: () => AssistantMessageEventStreamLike
  streamProvider: (
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ) => AssistantMessageEventStreamLike
  streamGenerate: (
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
  let apiKey: string | undefined

  function pipe(
    source: AssistantMessageEventStreamLike,
    target: AssistantMessageEventStreamLike,
  ): Promise<void> {
    return (async () => {
      for await (const event of source) target.push(event)
    })()
  }

  return {
    getTransport(): CommandCodeTransport {
      return transport
    },

    reset(): void {
      transport = "unknown"
      apiKey = undefined
    },

    stream(
      model: ModelLike,
      context: ContextLike,
      options?: StreamOptions,
    ): AssistantMessageEventStreamLike {
      if (options?.apiKey !== apiKey) {
        apiKey = options?.apiKey
        transport = "unknown"
      }
      const requestApiKey = options?.apiKey
      if (transport === "generate") return deps.streamGenerate(model, context, options)

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
        onResponse: async (response, responseModel) => {
          if (upgradeRequired) return
          await options?.onResponse?.(response, responseModel)
        },
      }

      const run = async () => {
        const providerStream = deps.streamProvider(model, context, providerOptions)

        try {
          for await (const event of providerStream) {
            if (!upgradeRequired) {
              if (apiKey === requestApiKey) transport = "provider"
              output.push(event)
            }
          }
        } catch (error) {
          // Defense in depth for adapters whose iterators reject after HTTP errors;
          // current Pi/OMP adapters emit error events instead. Only an inspected
          // upgrade_required response permits generate fallback.
          if (!upgradeRequired) throw error
        }

        if (upgradeRequired) {
          if (apiKey === requestApiKey) transport = "generate"
          await pipe(deps.streamGenerate(model, context, options), output)
        }
        output.end()
      }

      run().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        output.push({
          type: "error",
          reason: "error",
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
            stopReason: "error",
            errorMessage: message,
            timestamp: Date.now(),
          },
        })
        output.end()
      })

      return output
    },
  }
}
