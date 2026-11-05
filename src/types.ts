/** JSON values carried by parsed wire events and tool-call arguments. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue }

export type StopReason = "stop" | "length" | "toolUse" | "deferred"
export type ErrorReason = "error" | "aborted"
export type TerminalReason = StopReason | ErrorReason

export interface UsageCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
  totalTokens: number
  cost: UsageCost
}

export interface TextContent {
  type: "text"
  text: string
}

export interface ThinkingContent {
  type: "thinking"
  thinking: string
}

export interface ToolCallContent {
  type: "toolCall"
  id: string
  name: string
  arguments: JsonObject
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent

export interface AssistantMessageLike {
  role: "assistant"
  content: AssistantContent[]
  api: string
  provider: string
  model: string
  usage: Usage
  stopReason: TerminalReason | "pending"
  errorMessage?: string
  timestamp: number
}

export interface ModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelCostTier extends ModelCostRates {
  inputTokensAbove: number
}

export interface ModelCost extends ModelCostRates {
  tiers?: readonly ModelCostTier[]
}

export interface ModelLike {
  id: string
  api: string
  provider: string
  maxTokens: number
  cost: ModelCost
  /** Input modalities the host advertises, including `models.yml`/`models.json` overrides. */
  input?: readonly string[]
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<string, string | null>>
  thinking?: {
    mode?: "effort"
    effortMap?: Partial<Record<string, string>>
    efforts?: readonly string[]
  }
}

export interface MessageLike {
  role: string
  content?: unknown
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

export interface ToolLike {
  name: string
  description?: string
  parameters?: unknown
}

export interface ContextLike {
  systemPrompt?: string
  messages?: readonly MessageLike[]
  tools?: readonly ToolLike[]
}

export interface ProviderResponseInfo {
  status: number
  headers: Record<string, string>
}

export interface StreamOptions<
  TModel extends ModelLike = ModelLike,
  TReasoning extends string = string,
> {
  apiKey?: string
  signal?: AbortSignal
  headers?: Record<string, string | null>
  fetch?: typeof fetch
  maxTokens?: number
  temperature?: number
  sessionId?: string
  /** Resolved pi thinking level; forwarded only through the model's map. */
  reasoning?: TReasoning
  onPayload?: (payload: unknown, model: TModel) => unknown | Promise<unknown>
  onResponse?: (response: ProviderResponseInfo, model: TModel) => void | Promise<void>
  /** Forwarded to the native host; it owns timeout and retry semantics. */
  timeoutMs?: number
  /** Native provider retry budget, separate from the host agent's retries. */
  maxRetries?: number
  /** Native provider Retry-After limit; no extension-owned retry loop exists. */
  maxRetryDelayMs?: number
}

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessageLike }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessageLike }
  | {
      type: "text_delta"
      contentIndex: number
      delta: string
      partial: AssistantMessageLike
    }
  | {
      type: "text_end"
      contentIndex: number
      content: string
      partial: AssistantMessageLike
    }
  | {
      type: "thinking_start"
      contentIndex: number
      partial: AssistantMessageLike
    }
  | {
      type: "thinking_delta"
      contentIndex: number
      delta: string
      partial: AssistantMessageLike
    }
  | {
      type: "thinking_end"
      contentIndex: number
      content: string
      partial: AssistantMessageLike
    }
  | {
      type: "toolcall_start"
      contentIndex: number
      partial: AssistantMessageLike
    }
  | {
      type: "toolcall_delta"
      contentIndex: number
      delta: string
      partial: AssistantMessageLike
    }
  | {
      type: "toolcall_end"
      contentIndex: number
      toolCall: ToolCallContent
      partial: AssistantMessageLike
    }
  | { type: "done"; reason: StopReason; message: AssistantMessageLike }
  | { type: "error"; reason: ErrorReason; error: AssistantMessageLike }

export interface AssistantMessageEventStreamLike extends AsyncIterable<AssistantMessageEvent> {
  push(event: AssistantMessageEvent): void
  end(): void
}
