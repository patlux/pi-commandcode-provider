import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequestDiagnostics, formatDiagnostics, priceStatus } from "../src/diagnostics.ts"
import {
  createTestDeps,
  createTestEventStream,
  collectEvents,
  makeContext,
  makeModel,
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
