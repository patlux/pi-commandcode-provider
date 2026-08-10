import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { MessageLike, StopReason, ToolLike } from "./types.ts"
import { toJsonSchema } from "./json-schema.ts"

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
    if (imageParts(message.content).length > 0) {
      const role = message.role === "toolResult" ? "tool results" : `${message.role} messages`
      throw imageContentError(role)
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

export function textContent(message: { content?: unknown }): string {
  return recordArray(message.content)
    .filter((part) => part.type === "text")
    .map((part) => stringValue(part.text) ?? "")
    .join("\n")
}

export function getEnvironmentInfo(): string {
  return `${process.platform}-${process.arch}, Node.js ${process.version}`
}

export function toolsToJson(tools?: readonly ToolLike[]): unknown[] {
  if (!tools) return []
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ? toJsonSchema(tool.parameters) : {},
  }))
}

function completeToolCallIds(messages?: readonly MessageLike[]): Set<string> {
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
    } else if (message.role === "toolResult") {
      if (message.toolCallId) resultIds.add(message.toolCallId)
    }
  }

  return new Set([...callIds].filter((id) => resultIds.has(id)))
}

export function messagesToCC(
  messages?: readonly MessageLike[],
  options: { allowImages?: boolean } = {},
): unknown[] {
  const allowImages = options.allowImages ?? false
  if (!allowImages) assertTextOnlyMessages(messages)

  const out: unknown[] = []
  const pairedToolCallIds = completeToolCallIds(messages)

  for (const message of messages ?? []) {
    if (message.role === "user") {
      out.push({
        role: "user",
        content: userContentToCommandCode(message.content, allowImages),
      })
    } else if (message.role === "assistant") {
      const parts: unknown[] = []
      for (const content of recordArray(message.content)) {
        if (content.type === "text") {
          parts.push({ type: "text", text: stringValue(content.text) ?? "" })
        } else if (content.type === "toolCall") {
          const toolCallId = stringValue(content.id) ?? ""
          if (!pairedToolCallIds.has(toolCallId)) continue
          parts.push({
            type: "tool-call",
            toolCallId,
            toolName: stringValue(content.name) ?? "",
            input: recordOrEmpty(content.arguments),
          })
        }
      }
      if (parts.length > 0) out.push({ role: "assistant", content: parts })
    } else if (message.role === "toolResult") {
      if (!message.toolCallId || !pairedToolCallIds.has(message.toolCallId)) continue
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: message.isError
              ? { type: "error-text", value: textContent(message) }
              : { type: "text", value: textContent(message) },
          },
        ],
      })

      const images = imageParts(message.content)
      if (images.length > 0) {
        if (!allowImages) throw imageContentError("tool results")
        out.push({
          role: "user",
          content: images.map(imageToCommandCode),
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
