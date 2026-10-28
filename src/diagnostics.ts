import {
  MODEL_INPUT_MODALITIES,
  MODEL_REASONING,
  MODEL_EFFORTS,
  COMMAND_CODE_CLI_VERSION,
} from "./commandcode-catalog.ts"
import { MODEL_COSTS, PRICING_LAST_VERIFIED, TEMPORARY_PRICING } from "./pricing.ts"
import type {
  AssistantMessageEventStreamLike,
  ContextLike,
  ModelLike,
  StreamOptions,
} from "./types.ts"

export interface RequestDiagnostic {
  model: string
  endpoint?: string
  status?: number
  requestId?: string
  attempts: number
  firstChunkMs?: number
  longestChunkGapMs: number
  durationMs?: number
  outcome: "pending" | "done" | "error" | "aborted"
  error?:
    | "authentication"
    | "permission"
    | "rate_limit"
    | "server"
    | "context_length"
    | "timeout"
    | "request_failed"
}

export function priceStatus(
  modelId: string,
  now = Date.now(),
): "known" | "unknown" | "review-required" {
  if (!MODEL_COSTS[modelId]) return "unknown"
  const day = new Date(now).toISOString().slice(0, 10)
  return TEMPORARY_PRICING.some(
    (promotion) => promotion.models.includes(modelId) && promotion.expiresOn < day,
  )
    ? "review-required"
    : "known"
}

function safeIdentifier(value: string): string {
  return /^[a-zA-Z0-9_./:+-]{1,160}$/.test(value) && !/\b(?:user|cc)_[a-zA-Z0-9_-]{8,}/.test(value)
    ? value
    : "[redacted]"
}

function classify(status: number | undefined, message: string): RequestDiagnostic["error"] {
  if (status === 401) return "authentication"
  if (status === 403) return "permission"
  if (status === 429) return "rate_limit"
  if (status && status >= 500) return "server"
  if (/context_length_exceeded/.test(message)) return "context_length"
  if (/timed?\s*out/i.test(message)) return "timeout"
  return "request_failed"
}

const ENDPOINTS = [
  "/provider/v1/responses",
  "/provider/v1/chat/completions",
  "/provider/v1/messages",
  "/alpha/generate",
]

/** Memory-only, content-free measurements. Never retain URLs, headers, bodies or credentials. */
export function createRequestDiagnostics(now: () => number = Date.now) {
  let latest: RequestDiagnostic | undefined
  return {
    snapshot: () => (latest ? { ...latest } : undefined),
    stream(
      source: (
        model: ModelLike,
        context: ContextLike,
        options?: StreamOptions,
      ) => AssistantMessageEventStreamLike,
      createStream: () => AssistantMessageEventStreamLike,
      model: ModelLike,
      context: ContextLike,
      options?: StreamOptions,
    ): AssistantMessageEventStreamLike {
      const started = now()
      const record: RequestDiagnostic = {
        model: safeIdentifier(model.id),
        attempts: 0,
        longestChunkGapMs: 0,
        outcome: "pending",
      }
      latest = record
      const output = createStream()
      let lastChunk: number | undefined
      const instrumented: StreamOptions = {
        ...options,
        fetch: async (input, init) => {
          record.attempts += 1
          lastChunk = undefined
          try {
            const pathname = new URL(
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            ).pathname
            record.endpoint = ENDPOINTS.find((path) => pathname === path) ?? "custom endpoint"
          } catch {
            record.endpoint = "custom endpoint"
          }
          const response = await (options?.fetch ?? fetch)(input, init)
          record.status = response.status
          const requestId =
            response.headers.get("x-request-id") ?? response.headers.get("request-id")
          record.requestId =
            requestId && /^[a-f0-9-]{16,64}$/i.test(requestId) ? requestId : undefined
          if (!response.body) return response
          return new Response(
            response.body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  const at = now()
                  if (record.firstChunkMs === undefined) record.firstChunkMs = at - started
                  if (lastChunk !== undefined)
                    record.longestChunkGapMs = Math.max(record.longestChunkGapMs, at - lastChunk)
                  lastChunk = at
                  controller.enqueue(chunk)
                },
              }),
            ),
            { status: response.status, statusText: response.statusText, headers: response.headers },
          )
        },
      }
      const run = async () => {
        try {
          for await (const event of source(model, context, instrumented)) {
            if (event.type === "done") record.outcome = "done"
            if (event.type === "error") {
              record.outcome = event.reason === "aborted" ? "aborted" : "error"
              record.error = classify(record.status, event.error.errorMessage ?? "")
            }
            output.push(event)
          }
        } catch (error) {
          record.outcome = options?.signal?.aborted ? "aborted" : "error"
          record.error = classify(record.status, error instanceof Error ? error.message : "")
          output.push({
            type: "error",
            reason: record.outcome === "aborted" ? "aborted" : "error",
            error: {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: now(),
              stopReason: record.outcome === "aborted" ? "aborted" : "error",
              errorMessage:
                "Command Code request failed before completing the stream; see /commandcode-diagnostics",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          })
        } finally {
          record.durationMs = now() - started
          output.end()
        }
      }
      run().catch(() => output.end())
      return output
    },
  }
}

export function formatDiagnostics(input: {
  pluginVersion: string
  host: string
  hostVersion: string
  modelId?: string
  route: string
  request?: RequestDiagnostic
}): string {
  const modelId = input.modelId
  const known =
    modelId &&
    (MODEL_INPUT_MODALITIES[modelId] || MODEL_REASONING[modelId] || MODEL_EFFORTS[modelId])
  return [
    `plugin: ${safeIdentifier(input.pluginVersion)}`,
    `host: ${safeIdentifier(input.host)} ${safeIdentifier(input.hostVersion)}`,
    `catalog CLI: ${COMMAND_CODE_CLI_VERSION}`,
    `model: ${modelId ? safeIdentifier(modelId) : "none"}`,
    // Caller supplies only a normalized routing description, never an error body.
    `route: ${input.route}`,
    `capabilities: ${known ? "bundled snapshot; host overrides may apply" : "not explicitly catalogued; conservative defaults"}`,
    `price: ${modelId ? priceStatus(modelId) : "unknown"} (verified ${PRICING_LAST_VERIFIED}; estimate, not billing)`,
    input.request ? `last request: ${JSON.stringify(input.request)}` : "last request: none",
    "Timing measures received body chunks, not tokens. No prompts, tool content, credentials, account IDs or local paths are included.",
  ].join("\n")
}
