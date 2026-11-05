import { createServer, type Server } from "node:http"
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  ContextLike,
  ModelLike,
  StreamOptions,
} from "../src/types.ts"

export function createTestEventStream(): AssistantMessageEventStreamLike {
  const events: AssistantMessageEvent[] = []
  const waiters: Array<() => void> = []
  let ended = false

  const wake = () => {
    const waiter = waiters.shift()
    if (waiter) waiter()
  }

  return {
    push(event: AssistantMessageEvent) {
      events.push(event)
      wake()
    },
    end() {
      ended = true
      while (waiters.length > 0) wake()
    },
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next(): Promise<IteratorResult<AssistantMessageEvent>> {
          while (index >= events.length && !ended) {
            await new Promise<void>((resolve) => waiters.push(resolve))
          }
          if (index < events.length) {
            const value = events[index]
            index += 1
            return { done: false, value }
          }
          return { done: true, value: undefined }
        },
      }
    },
  }
}

export async function collectEvents(
  stream: AssistantMessageEventStreamLike,
  timeoutMs = 2_000,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = []

  const collect = async () => {
    for await (const event of stream) {
      events.push(event)
      if (event.type === "done" || event.type === "error") break
    }
    return events
  }

  return await Promise.race([
    collect(),
    new Promise<AssistantMessageEvent[]>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Timed out collecting stream events after ${timeoutMs}ms`)),
        timeoutMs,
      )
    }),
  ])
}

export function makeModel(overrides: Partial<ModelLike> = {}): ModelLike {
  return {
    id: "deepseek/deepseek-v4-flash",
    api: "commandcode-custom",
    provider: "commandcode",
    maxTokens: 384_000,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    ...overrides,
  }
}

export function makeContext(overrides: Partial<ContextLike> = {}): ContextLike {
  return {
    systemPrompt: "You are a test assistant.",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    ...overrides,
  }
}

type SuccessPlan = {
  type: "success"
  status?: number
  events?: string[]
  chunks?: string[]
  delays?: number[]
  hangAfterLast?: boolean
  /** Delay in ms before the server starts sending the response. */
  responseDelay?: number
}

type ErrorPlan = {
  type: "error"
  status: number
  body: string
  headers?: Record<string, string>
}

export type ResponsePlan = SuccessPlan | ErrorPlan

export interface MockCommandCodeServer {
  baseUrl(): string
  mockResponse(plan: ResponsePlan): void
  close(): Promise<void>
  responseClosedBeforeEnd(): boolean
}

export async function startMockCommandCodeServer(): Promise<MockCommandCodeServer> {
  let responsePlan: ResponsePlan = { type: "success", events: [] }
  let closedBeforeEnd = false
  let port = 0

  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/provider/v1/chat/completions") {
      res.writeHead(404)
      res.end("Not found")
      return
    }

    // Drain the request without retaining unused payload or header snapshots.
    req.resume()
    req.on("end", () => {
      const plan = responsePlan

      if (plan.type === "error") {
        const headers: Record<string, string> = { "Content-Type": "text/plain", ...plan.headers }
        res.writeHead(plan.status, headers)
        res.end(plan.body)
        return
      }

      res.writeHead(plan.status ?? 200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
      })

      let ended = false
      res.on("close", () => {
        if (!ended) closedBeforeEnd = true
      })

      const chunks = plan.chunks ?? (plan.events ?? []).map((event) => `${event}\n`)
      const delays = plan.delays ?? chunks.map(() => 0)
      let index = 0

      const sendNext = () => {
        if (index >= chunks.length) {
          if (!plan.hangAfterLast) {
            ended = true
            res.end()
          }
          return
        }

        res.write(chunks[index])
        index += 1
        if (index < chunks.length) {
          setTimeout(sendNext, delays[index] ?? 0)
        } else if (!plan.hangAfterLast) {
          ended = true
          res.end()
        }
      }

      if (plan.responseDelay) {
        setTimeout(sendNext, plan.responseDelay)
      } else {
        sendNext()
      }
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address === "object" && address) port = address.port
      resolve()
    })
  })

  return {
    baseUrl: () => `http://127.0.0.1:${port}`,
    mockResponse(plan: ResponsePlan) {
      responsePlan = plan
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
        // A broken client abort must not leave hanging mock responses blocking teardown.
        server.closeAllConnections()
      })
    },
    responseClosedBeforeEnd: () => closedBeforeEnd,
  }
}

/** Synthetic byte source for diagnostics tests, NOT a production host adapter.
 * The fixture's newline frames only drive chunk timing/abort assertions. Real
 * Chat/Responses/Messages serialization is covered by the host contract suites.
 */
export function createDiagnosticSource(apiBase = "https://provider.test") {
  return (
    model: ModelLike,
    _context: ContextLike,
    options?: StreamOptions,
  ): AssistantMessageEventStreamLike => {
    const stream = createTestEventStream()
    const message = {
      role: "assistant" as const,
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
      stopReason: "stop" as const,
      timestamp: Date.now(),
    }
    const run = async () => {
      options?.signal?.throwIfAborted()
      let response: Response
      let attempt = 0
      for (;;) {
        response = await (options?.fetch ?? fetch)(`${apiBase}/provider/v1/chat/completions`, {
          method: "POST",
          body: "{}",
          signal: options?.signal,
        })
        if (response.ok) break
        const detail = await response.text()
        if (response.status !== 429 || attempt++ >= (options?.maxRetries ?? 0))
          throw new Error(detail)
      }
      const reader = response.body!.getReader()
      const cancel = () => {
        void reader.cancel().catch(() => {})
      }
      options?.signal?.addEventListener("abort", cancel, { once: true })
      try {
        const decoder = new TextDecoder()
        let pending = ""
        for (;;) {
          options?.signal?.throwIfAborted()
          const { done, value } = await reader.read()
          options?.signal?.throwIfAborted()
          if (done) break
          pending += decoder.decode(value, { stream: true })
          let index: number
          while ((index = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, index)
            pending = pending.slice(index + 1)
            const frame: unknown = JSON.parse(line)
            if (typeof frame !== "object" || frame === null) continue
            if (
              "type" in frame &&
              frame.type === "text-delta" &&
              "text" in frame &&
              typeof frame.text === "string"
            ) {
              stream.push({
                type: "text_delta",
                contentIndex: 0,
                delta: frame.text,
                partial: message,
              })
            }
          }
        }
        stream.push({ type: "done", reason: "stop", message })
      } finally {
        options?.signal?.removeEventListener("abort", cancel)
        if (options?.signal?.aborted) await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
    run()
      .catch(() => {
        const reason = options?.signal?.aborted ? "aborted" : "error"
        stream.push({ type: "error", reason, error: { ...message, stopReason: reason } })
      })
      .finally(() => stream.end())
    return stream
  }
}
