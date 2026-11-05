import { redactCommandCodeErrorText } from "./overflow.ts"
import type {
  AssistantMessageEventStreamLike,
  ContextLike,
  ModelLike,
  StreamOptions,
} from "./types.ts"

// Carries Patrick Wozniak's Provider API entitlement policy from PR #164.
export type CommandCodeTransport = "unknown" | "provider"

const PROVIDER_ACCESS_REQUIRED =
  "Command Code Provider API access is required (403 upgrade_required). The Go plan does not include API use. Use a plan with documented Provider API access and retry. If you changed accounts, sign in again. See https://commandcode.ai/docs/provider."

interface TransportDependencies<
  TModel extends ModelLike,
  TContext extends ContextLike,
  TReasoning extends string,
> {
  createStream: () => AssistantMessageEventStreamLike
  streamProvider: (
    model: TModel,
    context: TContext,
    options?: StreamOptions<TModel, TReasoning>,
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

export function createCommandCodeTransportRouter<
  TModel extends ModelLike = ModelLike,
  TContext extends ContextLike = ContextLike,
  TReasoning extends string = string,
>(deps: TransportDependencies<TModel, TContext, TReasoning>) {
  let transport: CommandCodeTransport = "unknown"
  let generation = 0

  return {
    getTransport: (): CommandCodeTransport => transport,
    reset(): void {
      generation += 1
      transport = "unknown"
    },
    stream(
      model: TModel,
      context: TContext,
      options?: StreamOptions<TModel, TReasoning>,
    ): AssistantMessageEventStreamLike {
      // Status describes the latest attempt, not a stale success or an assumed
      // entitlement. Neither a new key nor a catalog refresh caches a denial.
      const requestGeneration = ++generation
      transport = "unknown"
      const output = deps.createStream()
      let upgradeRequired = false
      let terminal = false
      const fetchImpl = options?.fetch ?? fetch
      const providerOptions: StreamOptions<TModel, TReasoning> = {
        ...options,
        fetch: async (input, init) => {
          const response = await fetchImpl(input, init)
          if (await isUpgradeRequired(response)) upgradeRequired = true
          return response
        },
        // Keep onResponse intact: diagnostics must observe denied HTTP status.
      }
      const run = async () => {
        try {
          for await (const event of deps.streamProvider(model, context, providerOptions)) {
            if (upgradeRequired) continue
            if (event.type === "done") {
              terminal = true
              if (generation === requestGeneration) transport = "provider"
            }
            if (event.type === "error") {
              terminal = true
              output.push({
                ...event,
                error: {
                  ...event.error,
                  errorMessage: redactCommandCodeErrorText(event.error.errorMessage ?? ""),
                },
              })
            } else {
              output.push(event)
            }
          }
        } catch (error) {
          // Hosts may emit an error event or reject the iterator after a 403.
          // Only the inspected entitlement response gets the static message.
          if (!upgradeRequired) throw error
        }
        if (upgradeRequired) throw new Error(PROVIDER_ACCESS_REQUIRED)
      }
      run()
        .catch((error: unknown) => {
          if (terminal) return
          const reason = options?.signal?.aborted ? "aborted" : "error"
          let message = PROVIDER_ACCESS_REQUIRED
          if (!upgradeRequired) {
            const detail = error instanceof Error ? error.message : String(error)
            message = redactCommandCodeErrorText(detail)
          }
          output.push({
            type: "error",
            reason,
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
              stopReason: reason,
              errorMessage: message,
              timestamp: Date.now(),
            },
          })
        })
        .finally(() => output.end())
      return output
    },
  }
}
