import { createServer, type IncomingHttpHeaders, type Server } from "node:http"

import {
  createStreamCommandCode,
  type AssistantMessageEvent,
  type AssistantMessageEventStreamLike,
  type ContextLike,
  type CoreDependencies,
  type ModelLike,
  type Usage,
} from "../src/core.ts"

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

export interface TestDepsResult {
  streamCommandCode: ReturnType<typeof createStreamCommandCode>
  calculatedUsages: Usage[]
}

export function createTestDeps(overrides: Partial<CoreDependencies> = {}): TestDepsResult {
  const calculatedUsages: Usage[] = []
  const streamCommandCode = createStreamCommandCode({
    createStream: createTestEventStream,
    calculateCost: (_model, usage) => {
      calculatedUsages.push({
        ...usage,
        cost: { ...usage.cost },
      })
    },
    env: {},
    authPaths: [],
    now: () => new Date("2026-05-05T12:00:00Z").getTime(),
    uuid: () => "00000000-0000-4000-8000-000000000000",
    cwd: () => "/repo",
    delay: async () => {},
    ...overrides,
  })
  return { streamCommandCode, calculatedUsages }
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

function headersToRecord(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value
    else if (Array.isArray(value)) out[key] = value.join(", ")
  }
  return out
}

export interface MockCommandCodeServer {
  baseUrl(): string
  mockResponse(plan: ResponsePlan): void
  mockResponseQueue(plans: ResponsePlan[]): void
  reset(): void
  close(): Promise<void>
  lastRequestBody(): unknown
  lastRequestHeaders(): Record<string, string>
  requestCount(): number
  responseClosedBeforeEnd(): boolean
}

export async function startMockCommandCodeServer(): Promise<MockCommandCodeServer> {
  let planQueue: ResponsePlan[] = [{ type: "success", events: [] }]
  let lastBody: unknown
  let lastHeaders: Record<string, string> = {}
  let requests = 0
  let closedBeforeEnd = false
  let port = 0

  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/alpha/generate") {
      res.writeHead(404)
      res.end("Not found")
      return
    }

    requests += 1
    lastHeaders = headersToRecord(req.headers)
    let body = ""
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8")
    })
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(body)
        lastBody = parsed
      } catch {
        lastBody = undefined
      }

      // Pop the first plan from the queue; keep the last one as fallback.
      const plan = planQueue.length > 1 ? planQueue.shift()! : planQueue[0]

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
    server.listen(0, () => {
      const address = server.address()
      if (typeof address === "object" && address) port = address.port
      resolve()
    })
  })

  return {
    baseUrl: () => `http://127.0.0.1:${port}`,
    mockResponse(plan: ResponsePlan) {
      planQueue = [plan]
    },
    mockResponseQueue(plans: ResponsePlan[]) {
      planQueue = [...plans]
    },
    reset() {
      planQueue = [{ type: "success", events: [] }]
      lastBody = undefined
      lastHeaders = {}
      requests = 0
      closedBeforeEnd = false
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
    lastRequestBody: () => lastBody,
    lastRequestHeaders: () => lastHeaders,
    requestCount: () => requests,
    responseClosedBeforeEnd: () => closedBeforeEnd,
  }
}

export function objectAt(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (Array.isArray(current)) {
      const index = Number(key)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== "object" || current === null) return undefined
    current = Object.getOwnPropertyDescriptor(current, key)?.value
  }
  return current
}
