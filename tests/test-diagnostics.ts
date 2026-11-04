import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequestDiagnostics, formatDiagnostics, priceStatus } from "../src/diagnostics.ts"
import {
  createTestDeps,
  createTestEventStream,
  collectEvents,
  makeContext,
  makeModel,
  startMockCommandCodeServer,
} from "./helpers.ts"

describe("content-free diagnostics", () => {
  it("distinguishes missing prices from explicit free models", () => {
    assert.equal(priceStatus("unknown/model"), "unknown")
    assert.equal(priceStatus("stealth/glyph-cluster:free"), "known")
  })
  it("preserves streams and measures body chunks without retaining contents", async () => {
    let now = 0
    const diagnostics = createRequestDiagnostics(() => now)
    const { streamCommandCode } = createTestDeps()
    const events = await collectEvents(
      diagnostics.stream(streamCommandCode, createTestEventStream, makeModel(), makeContext(), {
        apiKey: "synthetic-key",
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                now = 10
                controller.enqueue(
                  new TextEncoder().encode('{"type":"text-delta","text":"PRIVATE PROMPT"}\n'),
                )
                setTimeout(() => {
                  now = 50
                  controller.enqueue(
                    new TextEncoder().encode('{"type":"finish","finishReason":"stop"}\n'),
                  )
                  controller.close()
                }, 10)
              },
            }),
            { headers: { "x-request-id": "user_private_secret" } },
          ),
      }),
    )
    assert.equal(events.at(-1)?.type, "done")
    const record = diagnostics.snapshot()
    assert.equal(record?.attempts, 1)
    assert.equal(record?.outcome, "done")
    assert.equal(record?.firstChunkMs, 10)
    assert.equal(record?.longestChunkGapMs, 40)
    const report = formatDiagnostics({
      pluginVersion: "0.7.7",
      host: "pi",
      hostVersion: "1.1.0",
      route: "provider/openai-responses (auto)",
      modelId: "unknown/model",
      request: record,
    })
    assert.doesNotMatch(report, /PRIVATE PROMPT|synthetic-key|user_private_secret|Bearer/)
    assert.match(report, /price: unknown/)
  })
})

// Unlike collectEvents, consume through iterator completion so a missing end() fails.
async function throughEnd(
  stream: import("../src/types.ts").AssistantMessageEventStreamLike,
  onEvent?: (event: import("../src/types.ts").AssistantMessageEvent) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const events = []
        for await (const event of stream) {
          events.push(event)
          onEvent?.(event)
        }
        return events
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("diagnostics stream did not end")), 2_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const finishedBody = '{"type":"finish","finishReason":"stop"}\n'

describe("diagnostics trust boundary and lifecycle", () => {
  for (const modelId of [
    "sk-abcdefghijklmnopqrstuvwxyz",
    "user_syntheticprivateaccount",
    "/home/synthetic/private-project",
    "C:/synthetic/private-project",
    "../synthetic-private-project",
    "https://synthetic.invalid/private-project",
  ]) {
    it(`redacts an unsafe model identifier: ${modelId}`, async () => {
      const diagnostics = createRequestDiagnostics()
      const { streamCommandCode } = createTestDeps()
      await throughEnd(
        diagnostics.stream(
          streamCommandCode,
          createTestEventStream,
          makeModel({ id: modelId }),
          makeContext(),
          { apiKey: "synthetic-key", fetch: async () => new Response(finishedBody) },
        ),
      )
      assert.equal(diagnostics.snapshot()?.model, "[redacted]")
      const report = formatDiagnostics({
        pluginVersion: "0.7.12",
        host: "pi",
        hostVersion: "1.5.0",
        route: "provider/openai-responses",
        modelId,
        request: diagnostics.snapshot(),
      })
      assert.ok(!report.includes(modelId), "neither selected model nor last request may retain it")
    })
  }

  for (const throws of [false, true]) {
    it(`ends an aborted ${throws ? "throwing" : "event"} stream without an error category`, async () => {
      const diagnostics = createRequestDiagnostics()
      const controller = new AbortController()
      controller.abort()
      const { streamCommandCode } = createTestDeps()
      const events = await throughEnd(
        diagnostics.stream(
          throws
            ? () => {
                throw new Error("synthetic private abort detail")
              }
            : streamCommandCode,
          createTestEventStream,
          makeModel(),
          makeContext(),
          {
            apiKey: "synthetic-key",
            signal: controller.signal,
            fetch: async () => {
              throw new Error("aborted request must not fetch")
            },
          },
        ),
      )
      const terminal = events.at(-1)
      assert.equal(terminal?.type, "error")
      assert.equal(terminal?.type === "error" && terminal.reason, "aborted")
      assert.equal(diagnostics.snapshot()?.outcome, "aborted")
      assert.equal(diagnostics.snapshot()?.error, undefined)
      assert.ok(diagnostics.snapshot()?.durationMs !== undefined)
    })
  }

  for (const responseDelay of [0, 150]) {
    it(`preserves mid-stream abort and upstream cancellation (${responseDelay}ms response delay)`, async () => {
      const server = await startMockCommandCodeServer()
      const controller = new AbortController()
      try {
        server.mockResponse({
          type: "success",
          events: [JSON.stringify({ type: "text-delta", text: "synthetic first chunk" })],
          hangAfterLast: true,
          responseDelay,
        })
        const diagnostics = createRequestDiagnostics()
        const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })
        const events = await throughEnd(
          diagnostics.stream(streamCommandCode, createTestEventStream, makeModel(), makeContext(), {
            apiKey: "mock-key",
            signal: controller.signal,
          }),
          (event) => {
            if (event.type === "text_delta") controller.abort()
          },
        )
        assert.ok(events.some((event) => event.type === "text_delta"))
        const terminal = events.at(-1)
        assert.equal(terminal?.type === "error" && terminal.reason, "aborted")
        assert.equal(diagnostics.snapshot()?.outcome, "aborted")
        assert.equal(diagnostics.snapshot()?.error, undefined)
        const deadline = Date.now() + 2_000
        while (!server.responseClosedBeforeEnd() && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10))
        assert.ok(server.responseClosedBeforeEnd(), "measured abort must close upstream")
      } finally {
        controller.abort()
        await server.close()
      }
    })
  }

  it("records a retry's final status/ID but documents call-wide first-chunk timing", async () => {
    let now = 0
    let attempts = 0
    const diagnostics = createRequestDiagnostics(() => now)
    const { streamCommandCode } = createTestDeps()
    const requestId = "01234567-89ab-cdef-0123-456789abcdef"
    const events = await throughEnd(
      diagnostics.stream(streamCommandCode, createTestEventStream, makeModel(), makeContext(), {
        apiKey: "synthetic-key",
        maxRetries: 1,
        fetch: async () => {
          attempts++
          now = attempts === 1 ? 20 : 100
          return attempts === 1
            ? new Response("synthetic private rate-limit body", { status: 429 })
            : new Response(finishedBody, { headers: { "x-request-id": requestId } })
        },
      }),
    )
    assert.equal(events.at(-1)?.type, "done")
    assert.equal(attempts, 2)
    assert.deepEqual(diagnostics.snapshot(), {
      model: makeModel().id,
      attempts: 2,
      longestChunkGapMs: 0,
      outcome: "done",
      endpoint: "/alpha/generate",
      status: 200,
      requestId,
      firstChunkMs: 20,
      durationMs: 100,
    })
  })

  it("lets the most recently started request own the report despite late completion", async () => {
    const diagnostics = createRequestDiagnostics()
    const { streamCommandCode } = createTestDeps()
    let oldBody!: ReadableStreamDefaultController<Uint8Array>
    let newBody!: ReadableStreamDefaultController<Uint8Array>
    const oldResponse = new Response(
      new ReadableStream({
        start(c) {
          oldBody = c
        },
      }),
    )
    const newResponse = new Response(
      new ReadableStream({
        start(c) {
          newBody = c
        },
      }),
    )
    const oldEvents = throughEnd(
      diagnostics.stream(
        streamCommandCode,
        createTestEventStream,
        makeModel({ id: "older/model" }),
        makeContext(),
        { apiKey: "synthetic-key", fetch: async () => oldResponse },
      ),
    )
    const newEvents = throughEnd(
      diagnostics.stream(
        streamCommandCode,
        createTestEventStream,
        makeModel({ id: "newer/model" }),
        makeContext(),
        { apiKey: "synthetic-key", fetch: async () => newResponse },
      ),
    )
    oldBody.enqueue(new TextEncoder().encode(finishedBody))
    oldBody.close()
    await oldEvents
    assert.equal(diagnostics.snapshot()?.model, "newer/model")
    assert.equal(diagnostics.snapshot()?.outcome, "pending")
    newBody.enqueue(new TextEncoder().encode(finishedBody))
    newBody.close()
    await newEvents
    assert.equal(diagnostics.snapshot()?.model, "newer/model")
    assert.equal(diagnostics.snapshot()?.outcome, "done")
  })
})
