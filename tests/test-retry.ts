/**
 * Tests for retry and timeout behaviour driven by pi settings.json
 * retry config (timeoutMs, maxRetries, maxRetryDelayMs).
 */

import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it } from "node:test"

import type { AssistantMessageEvent } from "../src/core.ts"
import {
  collectEvents,
  createTestDeps,
  makeContext,
  makeModel,
  startMockCommandCodeServer,
  type MockCommandCodeServer,
} from "./helpers.ts"

let server: MockCommandCodeServer

before(async () => {
  server = await startMockCommandCodeServer()
})

after(async () => {
  await server.close()
})

beforeEach(() => {
  server.reset()
})

function eventTypes(events: readonly AssistantMessageEvent[]): string[] {
  return events.map((event) => event.type)
}

describe("streamCommandCode — retry on transient errors", () => {
  it("retries on 429 and succeeds on the second attempt", async () => {
    server.mockResponseQueue([
      { type: "error", status: 429, body: "rate limited" },
      {
        type: "success",
        events: [
          JSON.stringify({ type: "text-delta", text: "ok" }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
        ],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"])
    const done = events.at(-1)
    if (done?.type !== "done") throw new Error("expected done")
    assert.equal(done.reason, "stop")
  })

  it("retries on 500 and succeeds on the second attempt", async () => {
    server.mockResponseQueue([
      { type: "error", status: 500, body: "internal server error" },
      {
        type: "success",
        events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    assert.equal(server.requestCount(), 2)
    assert.equal(events.at(-1)?.type, "done")
  })

  it("does NOT retry on 400 (non-retryable client error)", async () => {
    server.mockResponse({ type: "error", status: 400, body: "bad request" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.match(last.error.errorMessage ?? "", /400/)
  })

  it("exhausts maxRetries and emits an error", async () => {
    server.mockResponse({ type: "error", status: 503, body: "unavailable" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        maxRetries: 3,
      }),
    )

    // initial attempt + 3 retries = 4 total
    assert.equal(server.requestCount(), 4)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const last503 = events.at(-1)
    if (last503?.type !== "error") throw new Error("expected error")
    assert.match(last503.error.errorMessage ?? "", /503/)
  })
})

describe("streamCommandCode — Retry-After header", () => {
  it("respects Retry-After delay in seconds", async () => {
    let delayCalled = false
    server.mockResponseQueue([
      {
        type: "error",
        status: 429,
        body: "rate limited",
        headers: { "retry-after": "2" },
      },
      {
        type: "success",
        events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      },
    ])
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      delay: async (ms: number) => {
        delayCalled = true
        assert.equal(ms, 2000)
      },
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    assert.equal(server.requestCount(), 2)
    assert.equal(events.at(-1)?.type, "done")
    assert.ok(delayCalled, "delay should have been called with Retry-After value")
  })

  it("fails immediately when Retry-After exceeds maxRetryDelayMs", async () => {
    server.mockResponse({
      type: "error",
      status: 429,
      body: "rate limited",
      headers: { "retry-after": "300" },
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        maxRetryDelayMs: 10_000,
      }),
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const lastMax = events.at(-1)
    if (lastMax?.type !== "error") throw new Error("expected error")
    assert.match(lastMax.error.errorMessage ?? "", /exceeds max/)
  })
})

describe("streamCommandCode — timeout", () => {
  it("retries on per-attempt timeout and succeeds", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
        hangAfterLast: true,
        responseDelay: 200,
      },
      {
        type: "success",
        events: [
          JSON.stringify({ type: "text-delta", text: "fast" }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
        ],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        timeoutMs: 50,
      }),
      5_000,
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"])
  })

  it("emits error when all retry attempts time out", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      hangAfterLast: true,
      responseDelay: 200,
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        timeoutMs: 50,
        maxRetries: 1,
      }),
      5_000,
    )

    // initial + 1 retry = 2
    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "error"])
  })
})

describe("streamCommandCode — abort cancels retry loop", () => {
  it("user abort stops retries immediately", async () => {
    server.mockResponse({ type: "error", status: 500, body: "error" })
    const controller = new AbortController()
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      delay: async (_ms: number, signal: AbortSignal) => {
        // Abort during the retry delay
        controller.abort()
        // Simulate the real delay which rejects on abort
        return new Promise<void>((_, reject) => {
          if (signal.aborted) reject(new DOMException("Aborted", "AbortError"))
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
        })
      },
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        signal: controller.signal,
        maxRetries: 10,
      }),
    )

    // Should only have made 1 request (the initial one), then aborted during delay
    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const error = events.at(-1)
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(error.reason, "aborted")
  })
})

describe("streamCommandCode — retry defaults", () => {
  it("uses default maxRetries of 2 when not specified", async () => {
    server.mockResponse({ type: "error", status: 500, body: "error" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    await collectEvents(streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }))

    // initial + 2 retries = 3
    assert.equal(server.requestCount(), 3)
  })

  it("respects maxRetries: 0 (no retries)", async () => {
    server.mockResponse({ type: "error", status: 500, body: "error" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        maxRetries: 0,
      }),
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "error"])
  })
})
