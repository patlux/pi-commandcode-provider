/**
 * Testable Command Code provider core.
 *
 * The runtime imports live in index.ts; this module takes injected stream/cost
 * dependencies so tests can exercise the real serialization and stream parser.
 */

import { randomUUID } from "node:crypto"

import { COMMAND_CODE_CLI_VERSION } from "./commandcode-catalog.ts"
import { commandCodeErrorMessage, redactCommandCodeErrorText } from "./overflow.ts"
import { modelSupportsImageInput } from "./models.ts"
import {
  getApiKey,
  getEnvironmentInfo,
  isRecord,
  assertTextOnlyMessages,
  mapFinishReason,
  messagesToCC,
  numberValue,
  parseStreamEventLine,
  pickCommandCodeApiKey,
  recordOrEmpty,
  stringValue,
  toolsToJson,
  systemPromptToText,
} from "./converters.ts"
import type {
  AssistantMessageEventStreamLike,
  AssistantMessageLike,
  ContextLike,
  CoreDependencies,
  ErrorReason,
  ModelLike,
  StopReason,
  StreamOptions,
  TerminalReason,
  TextContent,
  ToolCallContent,
  Usage,
} from "./types.ts"

export * from "./converters.ts"
export * from "./overflow.ts"
export * from "./types.ts"

export const DEFAULT_API_BASE = "https://api.commandcode.ai"
export { COMMAND_CODE_CLI_VERSION }

const DEFAULT_GENERATE_MAX_TOKENS = 64_000
const DEFAULT_MAX_RETRIES = 0
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000
const BASE_RETRY_DELAY_MS = 500

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000)
  return undefined
}

function effectiveMaxRetryDelayMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RETRY_DELAY_MS
  if (value === 0) return Number.POSITIVE_INFINITY
  return value
}

function retryDelayMs(
  attempt: number,
  retryAfterHeader: string | null,
  maxDelayMs: number,
): number {
  const retryAfterMs = parseRetryAfterSeconds(retryAfterHeader)
  if (retryAfterMs !== undefined) {
    if (retryAfterMs * 1000 > maxDelayMs) return -1
    return retryAfterMs * 1000
  }
  const exponential = BASE_RETRY_DELAY_MS * 2 ** attempt
  const jitter = exponential * 0.2 * Math.random()
  return Math.min(exponential + jitter, maxDelayMs)
}

function defaultUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function commandCodeUsage(event: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(event.totalUsage) ? event.totalUsage : undefined
}

function commandCodeInputTokenDetails(
  usage: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function abortError(message = "The operation was aborted"): DOMException {
  return new DOMException(message, "AbortError")
}

function timeoutError(timeoutMs: number | undefined): Error {
  return new Error(
    timeoutMs === undefined
      ? "Command Code API request timed out"
      : `Command Code API request timed out after ${timeoutMs}ms`,
  )
}

function successStopReason(reason: TerminalReason): StopReason {
  if (reason === "length" || reason === "toolUse") return reason
  return "stop"
}

function generateMaxTokens(model: ModelLike, options?: StreamOptions): number {
  return Math.min(
    options?.maxTokens ?? model.maxTokens,
    model.maxTokens,
    DEFAULT_GENERATE_MAX_TOKENS,
  )
}

function mappedReasoningEffort(model: ModelLike, options?: StreamOptions): string | undefined {
  const level = options?.reasoning
  if (!level || level === "off" || !model.reasoning) return undefined

  const effortMap = model.thinking?.effortMap ?? model.thinkingLevelMap
  const mapped = effortMap?.[level]
  return typeof mapped === "string" && mapped !== "off" ? mapped : undefined
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function projectSlugFromPath(pathName: string): string {
  const slug = pathName
    .toLowerCase()
    .replace(/^[a-z]:/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "project"
}

export function createStreamCommandCode(deps: CoreDependencies) {
  const apiBase = deps.apiBase ?? DEFAULT_API_BASE
  const fetchImpl = deps.fetchImpl ?? fetch
  const cwd = deps.cwd ?? (() => process.cwd())
  const now = deps.now ?? (() => Date.now())
  const uuid = deps.uuid ?? (() => randomUUID())
  const delay =
    deps.delay ??
    ((ms: number, signal: AbortSignal) => {
      if (signal.aborted) return Promise.reject(abortError())
      return new Promise<void>((resolve, reject) => {
        const id = setTimeout(() => {
          signal.removeEventListener("abort", onAbort)
          resolve()
        }, ms)
        const onAbort = () => {
          clearTimeout(id)
          reject(abortError())
        }
        signal.addEventListener("abort", onAbort, { once: true })
      })
    })

  function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError())

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError())
      signal.addEventListener("abort", onAbort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort)
          reject(error)
        },
      )
    })
  }

  function raceAbortWithTimeout<T>(
    promise: Promise<T>,
    controller: AbortController,
    timeoutMs: number | undefined,
  ): Promise<T> {
    if (timeoutMs === undefined) return raceAbort(promise, controller.signal)

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort()
        reject(timeoutError(timeoutMs))
      }, timeoutMs)
      raceAbort(promise, controller.signal).then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  return function streamCommandCode(
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ): AssistantMessageEventStreamLike {
    const stream = deps.createStream()

    async function run() {
      // Some hosts pass a literal env-var reference instead of resolving it.
      const apiKey = pickCommandCodeApiKey(
        options?.apiKey,
        getApiKey({
          env: deps.env,
          authPaths: deps.authPaths,
          homeDir: deps.homeDir,
        }),
      )

      if (!apiKey) {
        const msg: AssistantMessageLike = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: defaultUsage(),
          stopReason: "error",
          errorMessage:
            "No Command Code API key. Run /login and select Command Code, set COMMAND_CODE_API_KEY (or legacy COMMANDCODE_API_KEY), or configure ~/.commandcode/auth.json, ~/.pi/agent/auth.json or ~/.omp/agent/auth.json",
          timestamp: now(),
        }
        stream.push({ type: "error", reason: "error", error: msg })
        stream.end()
        return
      }

      const output: AssistantMessageLike = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: defaultUsage(),
        stopReason: "stop",
        timestamp: now(),
      }

      const controller = new AbortController()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let textBlock: TextContent | undefined
      let currentTextIdx = -1
      let thinkingIdx = -1
      const streamingToolCalls = new Map<
        string,
        { contentIndex: number; toolCall: ToolCallContent; partialArgs: string }
      >()
      let finished = false

      const abortUpstream = () => {
        if (!controller.signal.aborted) controller.abort()
        try {
          reader?.cancel().catch(() => undefined)
        } catch {
          // Reader cancellation is best-effort.
        }
      }

      if (options?.signal?.aborted) {
        abortUpstream()
      } else {
        options?.signal?.addEventListener("abort", abortUpstream, {
          once: true,
        })
      }

      const endTextBlock = () => {
        if (!textBlock) return
        stream.push({
          type: "text_end",
          contentIndex: currentTextIdx,
          content: textBlock.text,
          partial: output,
        })
        textBlock = undefined
        currentTextIdx = -1
      }

      const endThinking = () => {
        if (thinkingIdx < 0) return
        const tc = output.content[thinkingIdx]
        if (tc && tc.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex: thinkingIdx,
            content: (tc as { thinking: string }).thinking,
            partial: output,
          })
        }
        thinkingIdx = -1
      }

      const handleEvent = (event: unknown) => {
        if (!isRecord(event)) return

        switch (event.type) {
          case "text-delta": {
            endThinking()
            if (!textBlock) {
              textBlock = { type: "text", text: "" }
              output.content.push(textBlock)
              currentTextIdx = output.content.length - 1
              stream.push({
                type: "text_start",
                contentIndex: currentTextIdx,
                partial: output,
              })
            }
            const delta = stringValue(event.text) ?? ""
            textBlock.text += delta
            stream.push({
              type: "text_delta",
              contentIndex: currentTextIdx,
              delta,
              partial: output,
            })
            break
          }

          case "reasoning-start": {
            endTextBlock()
            break
          }

          case "reasoning-delta": {
            endTextBlock()
            const delta = stringValue(event.text) ?? ""
            if (thinkingIdx < 0) {
              output.content.push({ type: "thinking", thinking: delta })
              thinkingIdx = output.content.length - 1
              stream.push({
                type: "thinking_start",
                contentIndex: thinkingIdx,
                partial: output,
              })
            } else {
              const tc = output.content[thinkingIdx]
              if (tc && tc.type === "thinking") {
                ;(tc as { thinking: string }).thinking += delta
              }
            }
            stream.push({
              type: "thinking_delta",
              contentIndex: thinkingIdx,
              delta,
              partial: output,
            })
            break
          }

          case "reasoning-end": {
            endThinking()
            break
          }

          case "tool-result": {
            break
          }

          case "tool-input-start": {
            endTextBlock()
            endThinking()
            const id = stringValue(event.id)
            if (!id || streamingToolCalls.has(id)) break

            const toolCall: ToolCallContent = {
              type: "toolCall",
              id,
              name: stringValue(event.toolName) ?? "",
              arguments: {},
            }
            output.content.push(toolCall)
            const contentIndex = output.content.length - 1
            streamingToolCalls.set(id, { contentIndex, toolCall, partialArgs: "" })
            stream.push({
              type: "toolcall_start",
              contentIndex,
              partial: output,
            })
            break
          }

          case "tool-input-delta": {
            const id = stringValue(event.id)
            const delta = stringValue(event.delta)
            if (!id || delta === undefined) break
            const active = streamingToolCalls.get(id)
            if (!active) break

            active.partialArgs += delta
            active.toolCall.arguments = recordOrEmpty(active.partialArgs)
            stream.push({
              type: "toolcall_delta",
              contentIndex: active.contentIndex,
              delta,
              partial: output,
            })
            break
          }

          case "tool-input-end": {
            break
          }

          case "tool-call": {
            endTextBlock()
            endThinking()
            const id = stringValue(event.toolCallId) ?? ""
            const active = streamingToolCalls.get(id)
            const toolCall: ToolCallContent = active?.toolCall ?? {
              type: "toolCall",
              id,
              name: stringValue(event.toolName) ?? "",
              arguments: {},
            }
            toolCall.name = stringValue(event.toolName) ?? toolCall.name
            toolCall.arguments = recordOrEmpty(event.input ?? event.args ?? event.arguments)

            let contentIndex: number
            if (active) {
              contentIndex = active.contentIndex
              streamingToolCalls.delete(id)
            } else {
              output.content.push(toolCall)
              contentIndex = output.content.length - 1
              stream.push({
                type: "toolcall_start",
                contentIndex,
                partial: output,
              })
            }
            stream.push({
              type: "toolcall_end",
              contentIndex,
              toolCall,
              partial: output,
            })
            break
          }

          case "finish": {
            const rawFinishReason = stringValue(event.rawFinishReason)
            if (
              rawFinishReason &&
              /^(?:network|connection|upstream)[-_\s]?error$/i.test(rawFinishReason)
            ) {
              throw new Error(
                `Provider finished with reason "${rawFinishReason}" — upstream connection failed mid-stream`,
              )
            }
            const usage = commandCodeUsage(event)
            if (usage) {
              const details = commandCodeInputTokenDetails(usage)
              const totalInput = numberValue(usage.inputTokens) ?? 0
              const input = numberValue(details?.noCacheTokens)
              const cacheRead = numberValue(details?.cacheReadTokens) ?? 0
              const cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0
              output.usage.input = input ?? Math.max(0, totalInput - cacheRead - cacheWrite)
              output.usage.output = numberValue(usage.outputTokens) ?? 0
              output.usage.cacheRead = cacheRead
              output.usage.cacheWrite = cacheWrite
              output.usage.totalTokens =
                output.usage.input +
                output.usage.output +
                output.usage.cacheRead +
                output.usage.cacheWrite
              deps.calculateCost(model, output.usage)
            }
            output.stopReason = mapFinishReason(event.finishReason)
            finished = true
            break
          }

          case "abort": {
            throw abortError("Request aborted")
          }

          case "error": {
            const message =
              commandCodeErrorMessage(event.error) ??
              commandCodeErrorMessage(event.message) ??
              "Stream error"
            output.stopReason = "error"
            output.errorMessage = message
            throw new Error(message)
          }
        }
      }

      try {
        stream.push({ type: "start", partial: output })
        if (controller.signal.aborted) throw abortError("Aborted")

        const workingDir = cwd()
        const threadId = options?.sessionId
          ? isUuid(options.sessionId)
            ? options.sessionId
            : undefined
          : uuid()
        const reasoningEffort = mappedReasoningEffort(model, options)
        const timeoutMs = options?.timeoutMs

        const allowImages = modelSupportsImageInput(model.id)
        if (!allowImages) assertTextOnlyMessages(context.messages)

        let body: unknown = {
          config: {
            workingDir,
            date: new Date(now()).toISOString().split("T")[0],
            environment: getEnvironmentInfo(),
            structure: [],
            isGitRepo: false,
            currentBranch: "",
            mainBranch: "",
            gitStatus: "",
            recentCommits: [],
          },
          memory: null,
          taste: null,
          skills: null,
          params: {
            model: model.id,
            messages: messagesToCC(context.messages, { allowImages }),
            tools: toolsToJson(context.tools),
            system: systemPromptToText(context.systemPrompt),
            max_tokens: generateMaxTokens(model, options),
            stream: true,
            ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          },
          threadId,
        }

        const payloadController = new AbortController()
        const onPayloadAbort = () => payloadController.abort()
        controller.signal.addEventListener("abort", onPayloadAbort, { once: true })
        let nextBody: unknown
        try {
          nextBody = await raceAbortWithTimeout(
            Promise.resolve(options?.onPayload?.(body, model)),
            payloadController,
            timeoutMs,
          )
        } finally {
          controller.signal.removeEventListener("abort", onPayloadAbort)
        }
        if (nextBody !== undefined) body = nextBody

        const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES
        const maxRetryDelayMs = effectiveMaxRetryDelayMs(options?.maxRetryDelayMs)
        const requestHeaders = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "x-command-code-version": COMMAND_CODE_CLI_VERSION,
          "x-cli-environment": "production",
          "x-project-slug": projectSlugFromPath(workingDir),
          "x-taste-learning": "true",
          ...(options?.sessionId ? { "x-session-id": options.sessionId } : {}),
          "User-Agent": "cli",
          ...options?.headers,
        }
        const bodyStr = JSON.stringify(body)

        let response!: Response
        retryLoop: for (let attempt = 0; ; attempt++) {
          const attemptController = new AbortController()
          let attemptTimedOut = false
          let attemptTimeoutId: ReturnType<typeof setTimeout> | undefined

          const clearAttemptTimeout = () => {
            if (attemptTimeoutId !== undefined) {
              clearTimeout(attemptTimeoutId)
              attemptTimeoutId = undefined
            }
          }

          if (timeoutMs !== undefined) {
            attemptTimeoutId = setTimeout(() => {
              attemptTimedOut = true
              attemptController.abort()
            }, timeoutMs)
          }
          const onOuterAbort = () => attemptController.abort()
          controller.signal.addEventListener("abort", onOuterAbort, { once: true })
          const raceAttempt = <T>(promise: Promise<T>): Promise<T> =>
            raceAbort(promise, attemptController.signal).catch((error: unknown) => {
              if (attemptTimedOut) throw timeoutError(timeoutMs)
              throw error
            })

          try {
            try {
              response = await fetchImpl(`${apiBase}/alpha/generate`, {
                method: "POST",
                headers: requestHeaders,
                body: bodyStr,
                signal: attemptController.signal,
              })
            } catch (fetchError: unknown) {
              if (controller.signal.aborted) throw abortError("Aborted")
              if (attemptTimedOut) {
                if (attempt < maxRetries) continue retryLoop
                throw timeoutError(timeoutMs)
              }
              throw fetchError
            }

            // --- HTTP-level retry ---
            if (!response.ok && isRetryableStatus(response.status)) {
              const retryAfter = response.headers.get("retry-after")
              const waitMs = retryDelayMs(attempt, retryAfter, maxRetryDelayMs)
              if (waitMs < 0) {
                const requestedSeconds = parseRetryAfterSeconds(retryAfter) ?? 0
                const capLabel =
                  maxRetryDelayMs === Number.POSITIVE_INFINITY ? "disabled" : `${maxRetryDelayMs}ms`
                throw new Error(`Retry-After delay ${requestedSeconds}s exceeds max ${capLabel}`)
              }
              if (attempt < maxRetries) {
                await response.text().catch(() => "")
                if (waitMs > 0) await delay(waitMs, controller.signal)
                continue retryLoop
              }
            }

            try {
              await raceAttempt(
                Promise.resolve(
                  options?.onResponse?.(
                    {
                      status: response.status,
                      headers: headersToRecord(response.headers),
                    },
                    model,
                  ),
                ),
              )
            } catch (error: unknown) {
              if (attemptTimedOut && attempt < maxRetries) continue retryLoop
              throw error
            }

            if (!response.ok) {
              const errBody = await raceAttempt(response.text().catch(() => ""))
              let errorDetail: string | undefined
              try {
                const parsedBody: unknown = JSON.parse(errBody)
                errorDetail = commandCodeErrorMessage(parsedBody)
              } catch {
                // Preserve useful plain-text provider errors only after secret
                // redaction; upstream/proxy bodies may echo credentials.
              }
              const safeBody = redactCommandCodeErrorText(errBody).slice(0, 500)
              const detail = redactCommandCodeErrorText(
                errorDetail ?? (safeBody || "Provider returned an error"),
              )
              throw new Error(`Command Code API error ${response.status}: ${detail}`)
            }

            // --- Read response stream ---
            reader = response.body?.getReader()
            if (!reader) throw new Error("No response body")

            const decoder = new TextDecoder()
            let buffer = ""

            try {
              readLoop: for (;;) {
                if (controller.signal.aborted) throw abortError("Aborted")
                const { done, value } = await raceAbort(reader.read(), attemptController.signal)
                if (done) {
                  if (buffer.trim()) handleEvent(parseStreamEventLine(buffer))
                  if (!finished) {
                    throw new Error(
                      "Stream ended unexpectedly before completion (no finish event) — response was truncated",
                    )
                  }
                  break
                }
                if (controller.signal.aborted) throw abortError("Aborted")

                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split("\n")
                buffer = lines.pop() ?? ""

                for (const line of lines) {
                  if (controller.signal.aborted) throw abortError("Aborted")
                  handleEvent(parseStreamEventLine(line))
                  if (finished) break readLoop
                }
              }
            } catch (streamError: unknown) {
              // Stream-level error (e.g. API returned 200 OK but sent an error event)
              // or per-attempt timeout during stream reading.
              await reader.cancel().catch(() => {})
              try {
                reader.releaseLock()
              } catch {}
              reader = undefined

              if (
                controller.signal.aborted ||
                (streamError instanceof Error && streamError.name === "AbortError")
              ) {
                throw streamError
              }

              // Never retry after visible content was emitted (including timeout mid-stream).
              const canRetry = output.content.length === 0 && attempt < maxRetries
              if (canRetry) {
                output.content.length = 0
                textBlock = undefined
                currentTextIdx = -1
                thinkingIdx = -1
                output.stopReason = "stop"
                output.errorMessage = undefined
                finished = false
                const waitMs = attemptTimedOut ? 0 : retryDelayMs(attempt, null, maxRetryDelayMs)
                if (waitMs > 0) await delay(waitMs, controller.signal)
                continue retryLoop
              }
              if (attemptTimedOut) throw timeoutError(timeoutMs)
              throw streamError
            }

            // Stream completed successfully.
            endTextBlock()
            endThinking()

            stream.push({
              type: "done",
              reason: successStopReason(output.stopReason),
              message: output,
            })
            stream.end()
            break retryLoop
          } finally {
            controller.signal.removeEventListener("abort", onOuterAbort)
            clearAttemptTimeout()
          }
        }
      } catch (error: unknown) {
        const reason: ErrorReason =
          controller.signal.aborted || (error instanceof Error && error.name === "AbortError")
            ? "aborted"
            : "error"
        output.stopReason = reason
        output.errorMessage =
          reason === "aborted"
            ? "Request aborted"
            : redactCommandCodeErrorText(error instanceof Error ? error.message : String(error))
        stream.push({ type: "error", reason, error: output })
        stream.end()
      } finally {
        options?.signal?.removeEventListener("abort", abortUpstream)
        try {
          await reader?.cancel()
        } catch {
          // Reader may already be closed/cancelled.
        }
        try {
          reader?.releaseLock()
        } catch {
          // Reader may already be released/cancelled by the abort path.
        }
      }
    }

    run().catch((error: unknown) => {
      const msg: AssistantMessageLike = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: defaultUsage(),
        stopReason: "error",
        errorMessage: redactCommandCodeErrorText(
          error instanceof Error ? error.message : String(error),
        ),
        timestamp: now(),
      }
      stream.push({ type: "error", reason: "error", error: msg })
      stream.end()
    })

    return stream
  }
}
