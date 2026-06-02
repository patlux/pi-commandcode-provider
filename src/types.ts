export type StopReason = "stop" | "length" | "toolUse"
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
  arguments: Record<string, unknown>
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent

export interface AssistantMessageLike {
  role: "assistant"
  content: AssistantContent[]
  api: unknown
  provider: string
  model: string
  usage: Usage
  stopReason: TerminalReason
  errorMessage?: string
  timestamp: number
}

export interface ModelLike {
  id: string
  api: unknown
  provider: string
  maxTokens: number
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

export interface StreamOptions {
  apiKey?: string
  signal?: AbortSignal
  headers?: Record<string, string>
  maxTokens?: number
  onPayload?: (payload: unknown, model: ModelLike) => unknown | Promise<unknown>
  onResponse?: (response: ProviderResponseInfo, model: ModelLike) => void | Promise<void>
  /**
   * HTTP request timeout in milliseconds.
   * Applied per-attempt; on timeout the request is retried if retries remain.
   */
  timeoutMs?: number
  /**
   * Maximum retry attempts for transient HTTP errors (429, 5xx).
   * Default: 2.
   */
  maxRetries?: number
  /**
   * Maximum delay in milliseconds to wait for a retry when the server requests
   * a long wait via Retry-After. If the server's requested delay exceeds this
   * value, the request fails immediately. Default: 60000 (60 seconds).
   * Set to 0 to disable the cap.
   */
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

export interface CoreDependencies {
  createStream: () => AssistantMessageEventStreamLike
  calculateCost: (model: ModelLike, usage: Usage) => void
  apiBase?: string
  fetchImpl?: typeof fetch
  authPaths?: readonly string[]
  env?: NodeJS.ProcessEnv
  cwd?: () => string
  now?: () => number
  uuid?: () => string
  homeDir?: () => string
  /** Injectable delay for retry backoff. Defaults to setTimeout. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>
}
