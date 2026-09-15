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

const TEST_API_KEY = "option-key"

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
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 2,
      }),
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
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 2,
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.equal(events.at(-1)?.type, "done")
  })

  it("does NOT retry on 400 (non-retryable client error)", async () => {
    server.mockResponse({ type: "error", status: 400, body: "bad request" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: TEST_API_KEY }),
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
        apiKey: TEST_API_KEY,
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
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 2,
      }),
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
        apiKey: TEST_API_KEY,
        maxRetryDelayMs: 10_000,
      }),
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const lastMax = events.at(-1)
    if (lastMax?.type !== "error") throw new Error("expected error")
    assert.match(lastMax.error.errorMessage ?? "", /exceeds max/)
  })

  it("does not cap Retry-After when maxRetryDelayMs is 0", async () => {
    let delayCalled = false
    server.mockResponseQueue([
      {
        type: "error",
        status: 429,
        body: "rate limited",
        headers: { "retry-after": "120" },
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
        assert.equal(ms, 120_000)
      },
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 1,
        maxRetryDelayMs: 0,
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.equal(events.at(-1)?.type, "done")
    assert.ok(delayCalled)
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
        apiKey: TEST_API_KEY,
        timeoutMs: 50,
        maxRetries: 2,
      }),
      5_000,
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"])
  })

  it("retries when the response starts but the stream hangs before finish", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        events: [],
        hangAfterLast: true,
      },
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
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        timeoutMs: 50,
        maxRetries: 2,
      }),
      5_000,
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"])
  })

  it("does NOT retry on timeout after partial text-delta was emitted", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "text-delta", text: "partial" })],
      hangAfterLast: true,
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        timeoutMs: 50,
        maxRetries: 2,
      }),
      5_000,
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "error"])
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
        apiKey: TEST_API_KEY,
        timeoutMs: 50,
        maxRetries: 1,
      }),
      5_000,
    )

    // initial + 1 retry = 2
    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const error = events.at(-1)
    if (error?.type !== "error") throw new Error("expected error")
    assert.match(error.error.errorMessage ?? "", /timed out after 50ms/)
  })

  // https://github.com/patlux/pi-commandcode-provider/issues/87
  it("does not abort actively streaming responses that exceed timeoutMs overall", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({ type: "text-delta", text: "chunk 1 " }),
        JSON.stringify({ type: "text-delta", text: "chunk 2 " }),
        JSON.stringify({ type: "text-delta", text: "chunk 3 " }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ],
      delays: [0, 200, 200, 200],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        timeoutMs: 500,
      }),
      5_000,
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), [
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ])
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
        apiKey: TEST_API_KEY,
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
  it("uses default maxRetries of 0 when not specified", async () => {
    server.mockResponse({ type: "error", status: 500, body: "error" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    await collectEvents(streamCommandCode(makeModel(), makeContext(), { apiKey: TEST_API_KEY }))

    assert.equal(server.requestCount(), 1)
  })

  it("respects maxRetries: 0 (no retries)", async () => {
    server.mockResponse({ type: "error", status: 500, body: "error" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 0,
      }),
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "error"])
  })
})

describe("streamCommandCode — stream-level error retry", () => {
  it("retries when API returns 200 OK but stream contains an error event", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        events: [
          JSON.stringify({
            type: "error",
            error: "Service temporarily unavailable. Please try again shortly.",
          }),
        ],
      },
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
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 2,
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"])
  })

  it("exhausts retries on persistent stream-level errors", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({
          type: "error",
          error: "Service temporarily unavailable. Please try again shortly.",
        }),
      ],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 3,
      }),
    )

    // initial + 3 retries = 4
    assert.equal(server.requestCount(), 4)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.match(last.error.errorMessage ?? "", /temporarily unavailable/)
  })

  it("does NOT retry stream error when content was already emitted", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        events: [
          JSON.stringify({ type: "text-delta", text: "partial" }),
          JSON.stringify({
            type: "error",
            error: "Service temporarily unavailable",
          }),
        ],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: TEST_API_KEY }),
    )

    // Only 1 request — no retry because content was already emitted.
    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "error"])
  })
})
