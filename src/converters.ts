import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { MessageLike, StopReason, ToolLike } from "./types.ts"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
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

function promptPartToText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(promptPartToText).filter(Boolean).join("\n")
  if (!isRecord(value)) return ""

  const text = stringValue(value.text)
  if (text) return text

  const content = promptPartToText(value.content)
  if (content) return content

  return ""
}

export function systemPromptToText(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(promptPartToText).filter(Boolean).join("\n\n")
  return promptPartToText(value)
}

export function getEnvironmentInfo(): string {
  return `${process.platform}-${process.arch}, Node.js ${process.version}`
}

export function toJsonSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return {}

  const kind = stringValue(schema.kind) ?? stringValue(schema.type)
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined
  if (enumValues) {
    return { type: typeof enumValues[0], enum: enumValues }
  }

  switch (kind) {
    case "string":
    case "String":
      return { type: "string" }
    case "number":
    case "Number":
      return { type: "number" }
    case "boolean":
    case "Boolean":
      return { type: "boolean" }
    case "object":
    case "Object": {
      const properties: Record<string, unknown> = {}
      const inferredRequired: string[] = []
      const sourceProperties = isRecord(schema.properties) ? schema.properties : undefined
      const optional = Array.isArray(schema.optional)
        ? schema.optional.filter((item): item is string => typeof item === "string")
        : []

      if (sourceProperties) {
        for (const [key, value] of Object.entries(sourceProperties)) {
          properties[key] = toJsonSchema(value)
          const valueRecord = isRecord(value) ? value : undefined
          if (booleanValue(valueRecord?.optional) !== true && !optional.includes(key)) {
            inferredRequired.push(key)
          }
        }
      }

      const explicitRequired = Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : undefined
      const required = explicitRequired ?? inferredRequired
      const out: Record<string, unknown> = { type: "object" }
      if (Object.keys(properties).length > 0) out.properties = properties
      if (required.length > 0) out.required = required
      return out
    }
    case "array":
    case "Array":
      return {
        type: "array",
        items: toJsonSchema(schema.items ?? schema.element),
      }
    case "union":
    case "Union": {
      const variants = Array.isArray(schema.variants)
        ? schema.variants
        : Array.isArray(schema.anyOf)
          ? schema.anyOf
          : []
      for (const variant of variants) {
        const converted = toJsonSchema(variant)
        if (isRecord(converted) && Object.keys(converted).length > 0) return converted
      }
      return {}
    }
    case "optional":
    case "Optional":
      return toJsonSchema(schema.wrapped ?? schema.inner)
    default:
      return {}
  }
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

export function messagesToCC(messages?: readonly MessageLike[]): unknown[] {
  const out: unknown[] = []
  const pairedToolCallIds = completeToolCallIds(messages)

  for (const message of messages ?? []) {
    if (message.role === "user") {
      out.push({
        role: "user",
        content: typeof message.content === "string" ? message.content : message.content,
      })
    } else if (message.role === "assistant") {
      const parts: unknown[] = []
      for (const content of recordArray(message.content)) {
        if (content.type === "text") {
          parts.push({ type: "text", text: stringValue(content.text) ?? "" })
        } else if (content.type === "thinking") {
          parts.push({
            type: "reasoning",
            text: stringValue(content.thinking) ?? "",
          })
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
