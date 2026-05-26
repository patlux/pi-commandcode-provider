/**
 * Testable Command Code provider core.
 *
 * The runtime imports live in index.ts; this module takes injected stream/cost
 * dependencies so tests can exercise the real serialization and stream parser.
 */

import { randomUUID } from "node:crypto"

import {
  getApiKey,
  getEnvironmentInfo,
  isRecord,
  mapFinishReason,
  messagesToCC,
  numberValue,
  parseStreamEventLine,
  recordOrEmpty,
  stringValue,
  systemPromptToText,
  toolsToJson,
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
export * from "./types.ts"

export const DEFAULT_API_BASE = "https://api.commandcode.ai"
export const COMMAND_CODE_CLI_VERSION = "0.27.2"

const DEFAULT_GENERATE_MAX_TOKENS = 64_000

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

  return function streamCommandCode(
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ): AssistantMessageEventStreamLike {
    const stream = deps.createStream()

    async function run() {
      const apiKey =
        options?.apiKey ??
        getApiKey({
          env: deps.env,
          authPaths: deps.authPaths,
          homeDir: deps.homeDir,
        })

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
            "No Command Code API key. Run /login and select Command Code, set COMMANDCODE_API_KEY env var, or configure ~/.commandcode/auth.json, ~/.omp/agent/auth.json, or ~/.pi/agent/auth.json.",
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
      let thinkingBlock: string[] = []
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

      const flushThinkingBlock = () => {
        if (thinkingBlock.length === 0) return
        const thinkingText = thinkingBlock.join("")
        thinkingBlock = []
        output.content.push({ type: "thinking", thinking: thinkingText })
        const idx = output.content.length - 1
        stream.push({
          type: "thinking_start",
          contentIndex: idx,
          partial: output,
        })
        stream.push({
          type: "thinking_delta",
          contentIndex: idx,
          delta: thinkingText,
          partial: output,
        })
        stream.push({
          type: "thinking_end",
          contentIndex: idx,
          content: thinkingText,
          partial: output,
        })
      }

      const handleEvent = (event: unknown) => {
        if (!isRecord(event)) return

        switch (event.type) {
          case "text-delta": {
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
            thinkingBlock.push(stringValue(event.text) ?? "")
            break
          }

          case "reasoning-end": {
            flushThinkingBlock()
            break
          }

          case "tool-result": {
            break
          }

          case "tool-call": {
            endTextBlock()
            const toolCall: ToolCallContent = {
              type: "toolCall",
              id: stringValue(event.toolCallId) ?? "",
              name: stringValue(event.toolName) ?? "",
              arguments: recordOrEmpty(event.input ?? event.args ?? event.arguments),
            }
            output.content.push(toolCall)
            const idx = output.content.length - 1
            stream.push({
              type: "toolcall_start",
              contentIndex: idx,
              partial: output,
            })
            stream.push({
              type: "toolcall_end",
              contentIndex: idx,
              toolCall,
              partial: output,
            })
            break
          }

          case "finish": {
            const usage = commandCodeUsage(event)
            if (usage) {
              const details = commandCodeInputTokenDetails(usage)
              output.usage.input = numberValue(usage.inputTokens) ?? 0
              output.usage.output = numberValue(usage.outputTokens) ?? 0
              output.usage.cacheRead = numberValue(details?.cacheReadTokens) ?? 0
              output.usage.cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0
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

          case "error": {
            const errorRecord = isRecord(event.error) ? event.error : undefined
            const message =
              stringValue(errorRecord?.message) ?? stringValue(event.error) ?? "Stream error"
            output.stopReason = "error"
            output.errorMessage = message
            throw new Error(message)
          }
        }
      }

      try {
        stream.push({ type: "start", partial: output })

        const workingDir = cwd()
        const threadId = uuid()

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
            messages: messagesToCC(context.messages),
            tools: toolsToJson(context.tools),
            system: systemPromptToText(context.systemPrompt),
            max_tokens: Math.min(options?.maxTokens ?? model.maxTokens, 200_000),
            stream: true,
          },
          threadId,
        }

        const nextBody = await raceAbort(
          Promise.resolve(options?.onPayload?.(body, model)),
          controller.signal,
        )
        if (nextBody !== undefined) body = nextBody

        const response = await raceAbort(
          fetchImpl(`${apiBase}/alpha/generate`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
              "x-command-code-version": COMMAND_CODE_CLI_VERSION,
              "x-cli-environment": "production",
              "x-project-slug": projectSlugFromPath(workingDir),
              "x-taste-learning": "true",
              "x-co-flag": "false",
              ...options?.headers,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          }),
          controller.signal,
        )

        await raceAbort(
          Promise.resolve(
            options?.onResponse?.(
              {
                status: response.status,
                headers: headersToRecord(response.headers),
              },
              model,
            ),
          ),
          controller.signal,
        )

        if (!response.ok) {
          const errBody = await raceAbort(
            response.text().catch(() => ""),
            controller.signal,
          )
          throw new Error(`Command Code API error ${response.status}: ${errBody.slice(0, 500)}`)
        }

        reader = response.body?.getReader()
        if (!reader) throw new Error("No response body")

        const decoder = new TextDecoder()
        let buffer = ""

        readLoop: for (;;) {
          if (controller.signal.aborted) throw abortError("Aborted")
          const { done, value } = await raceAbort(reader.read(), controller.signal)
          if (done) {
            if (buffer.trim()) handleEvent(parseStreamEventLine(buffer))
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

        endTextBlock()
        flushThinkingBlock()

        stream.push({
          type: "done",
          reason: successStopReason(output.stopReason),
          message: output,
        })
        stream.end()
      } catch (error: unknown) {
        const reason: ErrorReason = controller.signal.aborted ? "aborted" : "error"
        output.stopReason = reason
        output.errorMessage =
          reason === "aborted"
            ? "Request aborted"
            : error instanceof Error
              ? error.message
              : String(error)
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
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: now(),
      }
      stream.push({ type: "error", reason: "error", error: msg })
      stream.end()
    })

    return stream
  }
}
