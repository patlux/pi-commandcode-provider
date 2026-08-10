/**
 * Integration tests for the real streamCommandCode core using a local mock
 * Command Code server. No real API key or pi runtime required.
 */

import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it } from "node:test"

import type { AssistantMessageEvent } from "../src/core.ts"
import { MODEL_EFFORTS, thinkingLevelMapForEfforts } from "../src/models.ts"
import {
  collectEvents,
  createTestDeps,
  makeContext,
  makeModel,
  objectAt,
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

describe("streamCommandCode — auth", () => {
  it("emits a missing-key error without touching the network", async () => {
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      env: {},
      authPaths: [],
    })
    const stream = streamCommandCode(makeModel(), makeContext(), {
      apiKey: "",
    })
    const events = await collectEvents(stream)

    assert.deepEqual(eventTypes(events), ["error"])
    assert.equal(events[0].type, "error")
    assert.equal(events[0].reason, "error")
    assert.match(events[0].error.errorMessage ?? "", /No Command Code API key/)
    assert.equal(server.requestCount(), 0)
  })

  it("ignores the literal env-var name and falls back to env", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      env: { COMMANDCODE_API_KEY: "env-key" },
    })

    await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "COMMANDCODE_API_KEY" }),
    )

    assert.equal(
      server.lastRequestHeaders().authorization,
      "Bearer env-key",
      "should resolve from env, not send the literal var name as the token",
    )
  })

  it("uses options.apiKey in the Authorization header", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      env: { COMMANDCODE_API_KEY: "env-key" },
    })

    await collectEvents(streamCommandCode(makeModel(), makeContext(), { apiKey: "option-key" }))

    assert.equal(server.lastRequestHeaders().authorization, "Bearer option-key")
  })
})

describe("streamCommandCode — successful streams", () => {
  it("emits start → text events → done and accumulates usage", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({ type: "text-delta", text: "Hel" }),
        JSON.stringify({ type: "text-delta", text: "lo" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: {
            inputTokens: 3124,
            outputTokens: 15,
            inputTokenDetails: { noCacheTokens: 52, cacheReadTokens: 3072 },
          },
        }),
      ],
    })
    const { streamCommandCode, calculatedUsages } = createTestDeps({
      apiBase: server.baseUrl(),
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    assert.deepEqual(eventTypes(events), [
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ])
    const done = events.at(-1)
    assert.equal(done?.type, "done")
    if (done?.type !== "done") throw new Error("expected done")
    assert.equal(done.reason, "stop")
    assert.equal(done.message.content[0]?.type, "text")
    assert.equal(
      done.message.content[0]?.type === "text" ? done.message.content[0].text : "",
      "Hello",
    )
    assert.equal(done.message.usage.input, 52)
    assert.equal(done.message.usage.cacheRead, 3072)
    assert.equal(done.message.usage.cacheWrite, 0)
    assert.equal(done.message.usage.totalTokens, 3139)
    assert.equal(calculatedUsages.length, 1)
  })

  it("sends images for vision-capable models", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    await collectEvents(
      streamCommandCode(
        makeModel({ id: "gpt-5.6-luna" }),
        makeContext({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "inspect" },
                { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
              ],
            },
          ],
        }),
        { apiKey: "mock-key" },
      ),
    )

    assert.equal(
      objectAt(server.lastRequestBody(), ["params", "messages", "0", "content", "1", "image"]),
      "data:image/png;base64,aGVsbG8=",
    )
  })

  it("rejects images before network access for text-only models", async () => {
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(
        makeModel({ id: "deepseek/deepseek-v4-pro" }),
        makeContext({
          messages: [
            {
              role: "user",
              content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
            },
          ],
        }),
        { apiKey: "mock-key" },
      ),
    )

    assert.equal(events.at(-1)?.type, "error")
    assert.equal(server.requestCount(), 0)
  })

  it("derives uncached input when noCacheTokens is missing", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: {
            inputTokens: 100,
            outputTokens: 10,
            inputTokenDetails: { cacheReadTokens: 75 },
          },
        }),
      ],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    const done = events.at(-1)
    assert.equal(done?.type, "done")
    if (done?.type !== "done") throw new Error("expected done")
    assert.equal(done.message.usage.input, 25)
    assert.equal(done.message.usage.cacheRead, 75)
    assert.equal(done.message.usage.cacheWrite, 0)
    assert.equal(done.message.usage.totalTokens, 110)
  })

  it("accounts for cache writes separately from uncached input", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: {
            inputTokens: 100,
            outputTokens: 10,
            inputTokenDetails: {
              noCacheTokens: 20,
              cacheReadTokens: 70,
              cacheWriteTokens: 10,
            },
          },
        }),
      ],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    const done = events.at(-1)
    assert.equal(done?.type, "done")
    if (done?.type !== "done") throw new Error("expected done")
    assert.equal(done.message.usage.input, 20)
    assert.equal(done.message.usage.cacheRead, 70)
    assert.equal(done.message.usage.cacheWrite, 10)
    assert.equal(done.message.usage.totalTokens, 110)
  })

  it("ends on finish without waiting for an open upstream connection", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({ type: "text-delta", text: "done" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ],
      hangAfterLast: true,
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
      500,
    )

    assert.equal(events.at(-1)?.type, "done")
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(server.responseClosedBeforeEnd(), "client should cancel the still-open response body")
  })

  it("emits reasoning and tool-call blocks in order", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({ type: "reasoning-start" }),
        JSON.stringify({ type: "reasoning-delta", text: "think" }),
        JSON.stringify({ type: "reasoning-end" }),
        JSON.stringify({ type: "text-delta", text: "Using tool" }),
        JSON.stringify({
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "read_file",
          input: JSON.stringify({ path: "/tmp/x" }),
        }),
        JSON.stringify({ type: "finish", finishReason: "tool-calls" }),
      ],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    assert.deepEqual(eventTypes(events), [
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_end",
      "done",
    ])
    const done = events.at(-1)
    if (done?.type !== "done") throw new Error("expected done")
    assert.equal(done.reason, "toolUse")
    assert.deepEqual(
      done.message.content.map((content) => content.type),
      ["thinking", "text", "toolCall"],
    )
    const toolCall = done.message.content[2]
    assert.equal(toolCall?.type === "toolCall" ? toolCall.name : "", "read_file")
  })

  it("flushes reasoning if finish arrives without reasoning-end", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({ type: "reasoning-delta", text: "unfinished thought" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    const done = events.at(-1)
    if (done?.type !== "done") throw new Error("expected done")
    assert.equal(done.message.content[0]?.type, "thinking")
  })

  it("closes thinking block before text when reasoning-end is missing", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({ type: "reasoning-start" }),
        JSON.stringify({ type: "reasoning-delta", text: "thinking" }),
        JSON.stringify({ type: "text-delta", text: "answer" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    assert.deepEqual(eventTypes(events), [
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ])
  })

  it("closes thinking block before tool-call when reasoning-end is missing", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({ type: "reasoning-start" }),
        JSON.stringify({ type: "reasoning-delta", text: "thinking" }),
        JSON.stringify({
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "read_file",
          input: JSON.stringify({ path: "/tmp/x" }),
        }),
        JSON.stringify({ type: "finish", finishReason: "tool-calls" }),
      ],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    assert.deepEqual(eventTypes(events), [
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "toolcall_start",
      "toolcall_end",
      "done",
    ])
  })
})

describe("streamCommandCode — request serialization", () => {
  it("rejects image input before sending a lossy request", async () => {
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })
    const events = await collectEvents(
      streamCommandCode(
        makeModel(),
        makeContext({
          messages: [
            {
              role: "user",
              content: [{ type: "image", data: "base64-data", mimeType: "image/png" }],
            },
          ],
        }),
        { apiKey: "mock-key" },
      ),
    )

    assert.deepEqual(eventTypes(events), ["start", "error"])
    const lastEvent = events.at(-1)
    assert.equal(lastEvent?.type, "error")
    if (lastEvent?.type === "error") {
      assert.match(lastEvent.error.errorMessage ?? "", /does not support image content/i)
    }
    assert.equal(server.requestCount(), 0)
  })
  it("sends the expected request body and default headers", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })
    const context = makeContext({
      messages: [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: [{ type: "text", text: "first response" }],
        },
        { role: "user", content: "second" },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            kind: "object",
            properties: { city: { kind: "string" } },
          },
        },
      ],
    })

    await collectEvents(
      streamCommandCode(makeModel(), context, {
        apiKey: "mock-key",
        maxTokens: 500,
      }),
    )

    const body = server.lastRequestBody()
    assert.equal(objectAt(body, ["config", "workingDir"]), "/repo")
    assert.equal(objectAt(body, ["config", "date"]), "2026-05-05")
    assert.equal(objectAt(body, ["params", "model"]), "deepseek/deepseek-v4-flash")
    assert.equal(objectAt(body, ["params", "stream"]), true)
    assert.equal(objectAt(body, ["params", "max_tokens"]), 500)
    assert.equal(objectAt(body, ["params", "reasoning_effort"]), undefined)
    assert.equal(objectAt(body, ["params", "temperature"]), 0.3)
    assert.equal(objectAt(body, ["params", "system"]), "You are a test assistant.")
    assert.equal(objectAt(body, ["memory"]), null)
    assert.equal(objectAt(body, ["taste"]), null)
    assert.equal(objectAt(body, ["skills"]), null)
    assert.equal(objectAt(body, ["permissionMode"]), undefined)
    assert.equal(objectAt(body, ["threadId"]), "00000000-0000-4000-8000-000000000000")
    assert.equal(
      objectAt(body, ["params", "messages", "1", "content", "0", "text"]),
      "first response",
    )
    assert.equal(objectAt(body, ["params", "tools", "0", "name"]), "get_weather")

    const headers = server.lastRequestHeaders()
    assert.equal(headers.authorization, "Bearer mock-key")
    assert.equal(headers["x-command-code-version"], "1.15.1")
    assert.equal(headers["x-project-slug"], "repo")
    assert.equal(headers["x-taste-learning"], "true")
    assert.equal(headers["x-co-flag"], "false")
    assert.equal(headers["x-session-id"], undefined)
  })

  it("accepts the legacy OMP nested reasoning map", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })
    const model = makeModel({
      id: "omp-compat-reasoning-model",
      reasoning: true,
      thinking: { effortMap: { high: "legacy-high" } },
    })

    await collectEvents(
      streamCommandCode(model, makeContext(), { apiKey: "mock-key", reasoning: "high" }),
    )

    assert.equal(objectAt(server.lastRequestBody(), ["params", "reasoning_effort"]), "legacy-high")
  })

  it("forwards a supported Pi reasoning level as reasoning_effort", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })
    const model = makeModel({
      id: "deepseek/deepseek-v4-flash",
      reasoning: true,
      thinkingLevelMap: thinkingLevelMapForEfforts(MODEL_EFFORTS["deepseek/deepseek-v4-flash"]),
    })

    await collectEvents(
      streamCommandCode(model, makeContext(), { apiKey: "mock-key", reasoning: "max" }),
    )

    assert.equal(objectAt(server.lastRequestBody(), ["params", "reasoning_effort"]), "max")
  })

  it("omits reasoning_effort for off, unsupported, and unknown reasoning levels", async () => {
    const model = makeModel({
      id: "deepseek/deepseek-v4-flash",
      reasoning: true,
      thinkingLevelMap: thinkingLevelMapForEfforts(MODEL_EFFORTS["deepseek/deepseek-v4-flash"]),
    })

    for (const reasoning of ["off", "low"] as const) {
      server.mockResponse({
        type: "success",
        events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      })
      const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

      await collectEvents(
        streamCommandCode(model, makeContext(), { apiKey: "mock-key", reasoning }),
      )
      assert.equal(
        objectAt(server.lastRequestBody(), ["params", "reasoning_effort"]),
        undefined,
        `${reasoning} should not be sent when it has no supported Command Code field`,
      )
      server.reset()
    }

    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })
    await collectEvents(
      streamCommandCode(
        makeModel({ id: "new-model-without-metadata", reasoning: false }),
        makeContext(),
        { apiKey: "mock-key", reasoning: "high" },
      ),
    )
    assert.equal(objectAt(server.lastRequestBody(), ["params", "reasoning_effort"]), undefined)
  })

  it("caps maxTokens and passes custom headers", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    await collectEvents(
      streamCommandCode(makeModel({ maxTokens: 500_000 }), makeContext(), {
        apiKey: "mock-key",
        maxTokens: 500_000,
        headers: { "x-custom": "value" },
      }),
    )

    assert.equal(objectAt(server.lastRequestBody(), ["params", "max_tokens"]), 64_000)
    assert.equal(server.lastRequestHeaders()["x-custom"], "value")
  })

  it("caps default maxTokens by the selected model", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    await collectEvents(
      streamCommandCode(makeModel({ maxTokens: 8_192 }), makeContext(), {
        apiKey: "mock-key",
      }),
    )

    assert.equal(objectAt(server.lastRequestBody(), ["params", "max_tokens"]), 8_192)
  })

  it("serializes OMP system prompt arrays as a string", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    await collectEvents(
      streamCommandCode(
        makeModel(),
        makeContext({
          systemPrompt: ["You are a test assistant.", "Use concise answers."] as unknown as string,
        }),
        { apiKey: "mock-key" },
      ),
    )

    assert.equal(
      objectAt(server.lastRequestBody(), ["params", "system"]),
      "You are a test assistant.\n\nUse concise answers.",
    )
  })

  it("times out a hung onResponse callback", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })
    const started = Date.now()
    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        timeoutMs: 25,
        onResponse: async () => new Promise<void>(() => {}),
      }),
      1_000,
    )

    assert.ok(Date.now() - started < 500)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.match(error.error.errorMessage ?? "", /timed out after 25ms/)
  })

  it("times out a hung onPayload callback", async () => {
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })
    const started = Date.now()
    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        timeoutMs: 25,
        onPayload: async () => new Promise<unknown>(() => {}),
      }),
      1_000,
    )

    assert.ok(Date.now() - started < 500)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.match(error.error.errorMessage ?? "", /timed out after 25ms/)
    assert.equal(server.requestCount(), 0)
  })

  it("runs onPayload and onResponse hooks", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })
    let responseStatus = 0

    await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        onPayload: () => ({ replaced: true }),
        onResponse: (response) => {
          responseStatus = response.status
        },
      }),
    )

    assert.equal(objectAt(server.lastRequestBody(), ["replaced"]), true)
    assert.equal(responseStatus, 200)
  })
})

describe("streamCommandCode — upstream errors and malformed streams", () => {
  it("emits error for HTTP failures", async () => {
    server.mockResponse({ type: "error", status: 429, body: "rate limited" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    assert.deepEqual(eventTypes(events), ["start", "error"])
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.match(error.error.errorMessage ?? "", /429/)
  })

  it("emits error for provider error events", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({
          type: "error",
          error: { message: "provider failed" },
        }),
      ],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(error.error.errorMessage, "provider failed")
  })

  it("handles SSE lines, malformed lines, split chunks, and final line without newline", async () => {
    const textEvent = `data: ${JSON.stringify({ type: "text-delta", text: "split" })}\n`
    const finishEvent = JSON.stringify({
      type: "finish",
      finishReason: "max_tokens",
    })
    server.mockResponse({
      type: "success",
      chunks: [
        "not json\n",
        textEvent.slice(0, 12),
        textEvent.slice(12),
        "event: ignored\n",
        "data: [DONE]\n",
        finishEvent,
      ],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )

    const done = events.at(-1)
    if (done?.type !== "done") throw new Error("expected done")
    assert.equal(done.reason, "length")
    assert.equal(
      done.message.content[0]?.type === "text" ? done.message.content[0].text : "",
      "split",
    )
  })
})
