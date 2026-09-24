import { isRecord } from "./converters.ts"
import type { ContextLike, MessageLike, ToolLike } from "./types.ts"

/**
 * pi 0.86+ hands providers a TranscriptContext: the system prompt and tool
 * declarations live in `role: "system"` transcript messages instead of the
 * top-level `systemPrompt` and `tools` fields. pi-ai exports readers that
 * replay those messages into the current prompt and tool set.
 */
export interface TranscriptReaders {
  getCurrentTools: (messages: readonly MessageLike[]) => readonly ToolLike[]
  getCurrentSystemPrompt: (messages: readonly MessageLike[]) => string
}

function isToolLike(value: unknown): value is ToolLike {
  return isRecord(value) && typeof value.name === "string"
}

/**
 * Resolve the readers from a pi-ai module at runtime. Oh My Pi's bundled pi-ai
 * lacks them, and a named import of a missing export fails extension loading.
 */
export function transcriptReadersFrom(module: object): TranscriptReaders | undefined {
  const getCurrentTools: unknown = Reflect.get(module, "getCurrentTools")
  const getCurrentSystemPrompt: unknown = Reflect.get(module, "getCurrentSystemPrompt")
  if (typeof getCurrentTools !== "function" || typeof getCurrentSystemPrompt !== "function") {
    return undefined
  }
  return {
    getCurrentTools: (messages) => {
      const tools: unknown = getCurrentTools(messages)
      return Array.isArray(tools) ? tools.filter(isToolLike) : []
    },
    getCurrentSystemPrompt: (messages) => {
      const prompt: unknown = getCurrentSystemPrompt(messages)
      return typeof prompt === "string" ? prompt : ""
    },
  }
}

/**
 * Fill the flat `systemPrompt` and `tools` fields that the generate transport
 * sends. Hosts that still pass them (Oh My Pi, pi before 0.86) are unchanged.
 */
export function withTranscriptPromptAndTools(
  context: ContextLike,
  readers: TranscriptReaders | undefined,
): ContextLike {
  if (!readers || context.systemPrompt !== undefined || context.tools !== undefined) return context
  const messages = context.messages ?? []
  return {
    ...context,
    systemPrompt: readers.getCurrentSystemPrompt(messages),
    tools: readers.getCurrentTools(messages),
  }
}
