import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { MessageLike, StopReason, ToolLike } from "./types.ts"
import { geminiSafeJsonSchema, toJsonSchema } from "./json-schema.ts"

export { toJsonSchema } from "./json-schema.ts"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function recordArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

export function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      if (isRecord(parsed)) return parsed
    } catch {
      // Some providers stream incomplete JSON argument fragments.
    }
  }
  return {}
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function defaultAuthPaths(home: string): string[] {
  return [
    join(home, ".commandcode", "auth.json"),
    join(home, ".omp", "agent", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
  ]
}

function apiKeyFromCredentialRecord(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined

  const type = stringValue(value.type)
  if (type === "api") return stringValue(value.key)
  if (type === "oauth") return stringValue(value.access)

  return stringValue(value.key) ?? stringValue(value.access)
}

function imageParts(value: unknown): readonly Record<string, unknown>[] {
  if (isRecord(value)) return value.type === "image" ? [value] : []
  return recordArray(value).filter((part) => part.type === "image")
}

function imageContentError(role: string): Error {
  return new Error(`Selected Command Code model does not support image content in ${role}`)
}

export function assertTextOnlyMessages(messages?: readonly MessageLike[]): void {
  for (const message of messages ?? []) {
    if (message.role !== "toolResult" && imageParts(message.content).length > 0) {
      throw imageContentError(`${message.role} messages`)
    }
  }
}

function imageToCommandCode(part: Record<string, unknown>): Record<string, string> {
  const data = stringValue(part.data)
  const mimeType = stringValue(part.mimeType)
  if (!data || !mimeType)
    throw new Error("Invalid image content: expected base64 data and mimeType")

  return {
    type: "image",
    image: `data:${mimeType};base64,${data}`,
    mimeType,
  }
}

function userContentToCommandCode(content: unknown, allowImages: boolean): unknown {
  if (typeof content === "string") return content

  return recordArray(content).flatMap((part) => {
    if (part.type === "text") return [{ type: "text", text: stringValue(part.text) ?? "" }]
    if (part.type === "image") {
      if (!allowImages) throw imageContentError("user messages")
      return [imageToCommandCode(part)]
    }
    return []
  })
}

export function getApiKey(
  options: {
    env?: NodeJS.ProcessEnv
    authPaths?: readonly string[]
    homeDir?: () => string
  } = {},
): string | undefined {
  const env = options.env ?? process.env
  if (env.COMMAND_CODE_API_KEY) return env.COMMAND_CODE_API_KEY
  if (env.COMMANDCODE_API_KEY) return env.COMMANDCODE_API_KEY

  const home = options.homeDir?.() ?? homedir()
  const authPaths = options.authPaths ?? defaultAuthPaths(home)

  for (const authPath of authPaths) {
    try {
      if (!existsSync(authPath)) continue
      const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"))
      if (!isRecord(parsed)) continue

      // Legacy: direct apiKey or commandcode field.
      const apiKey = stringValue(parsed.apiKey)
      if (apiKey) return apiKey
      const commandcode = stringValue(parsed.commandcode)
      if (commandcode) return commandcode

      // pi stores OAuth credentials as {"commandcode": {"type":"oauth","access":"..."}}.
      // The official Command Code CLI stores API credentials under "command-code".
      const providerKey =
        apiKeyFromCredentialRecord(parsed.commandcode) ??
        apiKeyFromCredentialRecord(parsed["command-code"])
      if (providerKey) return providerKey
    } catch {
      // Ignore malformed or unreadable auth files.
    }
  }

  return undefined
}

// Hosts such as OMP may pass a literal env-var name as the "resolved" registry
// key instead of the actual credential. Treat those as unresolved.
export const COMMAND_CODE_PLACEHOLDER_KEYS = new Set([
  "$COMMAND_CODE_API_KEY",
  "COMMAND_CODE_API_KEY",
  "$COMMANDCODE_API_KEY",
  "COMMANDCODE_API_KEY",
])

function usableCommandCodeApiKey(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined
  if (!trimmed) return undefined
  if (COMMAND_CODE_PLACEHOLDER_KEYS.has(trimmed)) return undefined
  return trimmed
}

/**
 * Pick the real API key from a host registry value and/or the env/auth-file
 * fallback, never returning a literal placeholder or an empty/whitespace value.
 * Pure/testable.
 */
export function pickCommandCodeApiKey(
  registryKey: string | undefined,
  hostKey: string | undefined,
): string | undefined {
  return usableCommandCodeApiKey(registryKey) ?? usableCommandCodeApiKey(hostKey)
}

/**
 * Replace a host-supplied placeholder (or missing key) with the configured
 * fallback. Used for both registerProvider and the Provider API stream path.
 */
export function withResolvedCommandCodeApiKey<T extends { apiKey?: string }>(
  options: T | undefined,
  configuredKey: string | undefined,
): T | { apiKey?: string } {
  const apiKey = pickCommandCodeApiKey(options?.apiKey, configuredKey)
  if (options && apiKey === options.apiKey) return options
  return { ...options, apiKey }
}

export function textContent(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content
  if (message.content === null || message.content === undefined) return ""
  if (!Array.isArray(message.content)) {
    try {
      return JSON.stringify(message.content) ?? String(message.content)
    } catch {
      return String(message.content)
    }
  }

  return recordArray(message.content)
    .filter((part) => part.type === "text")
    .map((part) => stringValue(part.text) ?? "")
    .join("\n")
}

export function getEnvironmentInfo(): string {
  return `${process.platform}-${process.arch}, Node.js ${process.version}`
}

export function toolsToJson(tools?: readonly ToolLike[], modelId?: string): unknown[] {
  if (!tools) return []
  const geminiSafe = modelId !== undefined && modelId.startsWith("google/gemini-")
  return tools.map((tool) => {
    const schema = tool.parameters ? toJsonSchema(tool.parameters) : {}
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      input_schema: geminiSafe ? geminiSafeJsonSchema(schema) : schema,
    }
  })
}

interface ToolCallState {
  callIds: ReadonlySet<string>
  resultIds: ReadonlySet<string>
}

/**
 * Bound for tool-call ids on the `/alpha/generate` wire (#141).
 *
 * Hosts store Responses tool-call ids compounded as `<call_id>|<item_id>`
 * (73 characters for the observed `call_<32hex>|fc_<32hex>` shape). The
 * generate backend rejects `call_id` values longer than 64 characters with
 * `400 input[N].call_id`, so compound ids must be shortened before sending.
 * The mapping is deterministic per request and shared by calls and results,
 * so pairing is preserved and distinct ids never collide.
 */
const GENERATE_TOOL_CALL_ID_LIMIT = 64

function generateToolCallIdHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8)
}

function shortenGenerateToolCallId(value: string): string {
  if (value.length <= GENERATE_TOOL_CALL_ID_LIMIT) return value
  const suffix = generateToolCallIdHash(value)
  const head = value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+$/, "")
  const keep = GENERATE_TOOL_CALL_ID_LIMIT - suffix.length - 1
  const truncated = head.slice(0, Math.max(0, keep)).replace(/_+$/, "")
  // Fall back to the raw hash when sanitizing leaves nothing usable.
  return truncated ? `${truncated}_${suffix}` : suffix
}

/**
 * Map every tool-call id referenced in this request to its generate-wire
 * form. Short ids pass through unchanged; overlong ids are shortened
 * deterministically, and on collision the later id keeps the next free
 * `_<hash>` suffix so every distinct id still maps to a distinct value.
 */
function generateToolCallIdMap(messages?: readonly MessageLike[]): Map<string, string> {
  const referenced = new Set<string>()
  for (const message of messages ?? []) {
    if (message.role === "assistant") {
      for (const content of recordArray(message.content)) {
        if (content.type === "toolCall") {
          const id = stringValue(content.id)
          if (id) referenced.add(id)
        }
      }
    } else if (message.role === "toolResult" && message.toolCallId) {
      referenced.add(message.toolCallId)
    }
  }

  const used = new Set<string>()
  const mapped = new Map<string, string>()
  for (const id of referenced) {
    let candidate = shortenGenerateToolCallId(id)
    if (used.has(candidate)) {
      const base = candidate.replace(/_+$/, "")
      let attempt = 0
      do {
        const suffix = generateToolCallIdHash(`${id}#${attempt}`)
        const keep = GENERATE_TOOL_CALL_ID_LIMIT - suffix.length - 1
        const head = base.slice(0, Math.max(0, keep)).replace(/_+$/, "")
        candidate = head ? `${head}_${suffix}` : suffix
        attempt += 1
      } while (used.has(candidate))
    }
    mapped.set(id, candidate)
    used.add(candidate)
  }
  return mapped
}

function toolCallState(messages?: readonly MessageLike[]): ToolCallState {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()

  for (const message of messages ?? []) {
    if (message.role === "assistant") {
      for (const content of recordArray(message.content)) {
        if (content.type === "toolCall") {
          const id = stringValue(content.id)
          if (id) callIds.add(id)
        }
      }
    } else if (message.role === "toolResult" && message.toolCallId) {
      resultIds.add(message.toolCallId)
    }
  }

  return { callIds, resultIds }
}

export function messagesToCC(
  messages?: readonly MessageLike[],
  options: { allowImages?: boolean } = {},
): unknown[] {
  const allowImages = options.allowImages ?? false
  if (!allowImages) assertTextOnlyMessages(messages)

  const out: unknown[] = []
  const { callIds, resultIds } = toolCallState(messages)
  const wireIds = generateToolCallIdMap(messages)
  const wireId = (id: string): string => wireIds.get(id) ?? id

  const rawMessages = messages ?? []
  for (let i = 0; i < rawMessages.length; i++) {
    const message = rawMessages[i]
    if (message.role === "user" || message.role === "developer") {
      // Hosts such as OMP steer the agent by injecting developer-role messages
      // (advisor notes, reminders, nudges) mid-conversation. /alpha/generate
      // only accepts user, assistant, and tool roles, so degrade the role to
      // user instead of dropping the message. Content and chronological
      // position are preserved; system-prompt hoisting would change semantics.
      out.push({
        role: "user",
        content: userContentToCommandCode(message.content, allowImages),
      })
    } else if (message.role === "assistant") {
      const parts: unknown[] = []
      const missingResults: unknown[] = []
      for (const content of recordArray(message.content)) {
        if (content.type === "text") {
          parts.push({ type: "text", text: stringValue(content.text) ?? "" })
        } else if (content.type === "toolCall") {
          const rawToolCallId = stringValue(content.id) ?? ""
          const toolName = stringValue(content.name) ?? ""
          if (!rawToolCallId) continue
          const toolCallId = wireId(rawToolCallId)
          parts.push({
            type: "tool-call",
            toolCallId,
            toolName,
            input: recordOrEmpty(content.arguments),
          })
          if (!resultIds.has(rawToolCallId)) {
            missingResults.push({
              type: "tool-result",
              toolCallId,
              toolName,
              output: {
                type: "error-text",
                value: "No result — the tool call did not complete (interrupted or lost).",
              },
            })
          }
        }
      }
      if (parts.length > 0) out.push({ role: "assistant", content: parts })
      if (missingResults.length > 0) out.push({ role: "tool", content: missingResults })
    } else if (message.role === "toolResult") {
      const pendingImages: Record<string, string>[] = []
      let j = i
      for (; j < rawMessages.length && rawMessages[j].role === "toolResult"; j++) {
        const toolMsg = rawMessages[j]
        if (!toolMsg.toolCallId || !callIds.has(toolMsg.toolCallId)) continue
        const images = imageParts(toolMsg.content)
        const text = textContent(toolMsg)
        const outputText =
          text ||
          (images.length > 0 && !allowImages
            ? "[Image omitted: model does not support images]"
            : "")
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: wireId(toolMsg.toolCallId),
              toolName: toolMsg.toolName,
              output: toolMsg.isError
                ? { type: "error-text", value: outputText }
                : { type: "text", value: outputText },
            },
          ],
        })

        if (images.length > 0 && allowImages) {
          pendingImages.push(...images.map(imageToCommandCode))
        }
      }
      i = j - 1

      if (pendingImages.length > 0) {
        out.push({
          role: "user",
          content: pendingImages,
        })
      }
    }
  }
  return out
}

export function parseStreamEventLine(line: string): unknown | undefined {
  let trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim()
  if (!trimmed || trimmed === "[DONE]") return undefined

  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed
  } catch {
    return undefined
  }
}

export function mapFinishReason(reason: unknown): StopReason {
  if (reason === "tool-calls") return "toolUse"
  if (
    reason === "length" ||
    reason === "max_tokens" ||
    reason === "max-tokens" ||
    reason === "max_output_tokens"
  ) {
    return "length"
  }
  return "stop"
}

function promptPartToText(value: unknown, depth = 0): string {
  if (depth > 10) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value
      .map((v) => promptPartToText(v, depth + 1))
      .filter(Boolean)
      .join("\n")
  if (!isRecord(value)) return ""
  const text = stringValue(value.text)
  if (text) return text
  const content = promptPartToText(value.content, depth + 1)
  if (content) return content
  return ""
}

export function systemPromptToText(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value
      .map((v) => promptPartToText(v, 0))
      .filter(Boolean)
      .join("\n\n")
  return promptPartToText(value, 0)
}
