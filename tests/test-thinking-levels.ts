/**
 * Contract tests for thinking-level metadata and reasoning_effort passthrough.
 *
 * Command Code's /alpha/generate accepts a reasoning_effort parameter whose
 * supported values vary per model (extracted from the official command-code CLI
 * into MODEL_EFFORTS). These tests verify:
 *   1. Each known model exposes exactly the tiers its MODEL_EFFORTS entry lists
 *      (validated offline for every entry, not just the flash model).
 *   2. Unknown models get no map (pi's default off..high applies).
 *   3. reasoning_effort appears in the request body only when a supported level
 *      is selected, and is omitted for "off" and for unsupported (null-mapped) levels.
 */

import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { after, before, beforeEach, describe, it } from "node:test"

import {
  loadCommandCodeModels,
  MODEL_EFFORTS,
  thinkingLevelMapForEfforts,
  thinkingMetadataForModel,
} from "../src/models.ts"
import {
  createTestDeps,
  makeContext,
  makeModel,
  type MockCommandCodeServer,
  startMockCommandCodeServer,
} from "./helpers.ts"

// Mirrors pi-ai's getSupportedThinkingLevels (pi-ai/dist/models.js): a level is
// available when reasoning is true; xhigh/max additionally require an explicit
// non-null thinkingLevelMap entry. Duplicated here so the test catches
// regressions that a presence check would miss.
const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

function supportedLevels(model: Record<string, unknown>): string[] {
  if (!model.reasoning) return ["off"]
  const map = model.thinkingLevelMap as Record<string, string | null> | undefined
  return ALL_LEVELS.filter((level) => {
    const mapped = map?.[level]
    if (mapped === null) return false
    if (level === "xhigh" || level === "max") return mapped !== undefined
    return true
  })
}

function paramsOf(server: MockCommandCodeServer): Record<string, unknown> {
  const body = server.lastRequestBody() as { params?: Record<string, unknown> } | undefined
  return body?.params ?? {}
}

// ────────────────────────────────────────────────────────────────────────────
// Pure function tests (no network)
// ────────────────────────────────────────────────────────────────────────────

describe("MODEL_EFFORTS + thinkingLevelMapForEfforts", () => {
  it("maps supported efforts to themselves and nulls the rest", () => {
    const map = thinkingLevelMapForEfforts(MODEL_EFFORTS["deepseek/deepseek-v4-flash"])
    assert.deepEqual(map, {
      off: "off",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    })
  })

  it("every MODEL_EFFORTS entry yields a valid map with correct supported tiers", () => {
    // Offline structural validation for every entry in the static table. Each
    // effort list must be a non-empty subset of valid effort levels, and
    // thinkingLevelMapForEfforts must produce a map whose visible tiers match
    // exactly. Catches transcription errors without network access.
    const VALID_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]
    for (const [id, efforts] of Object.entries(MODEL_EFFORTS)) {
      assert.ok(efforts.length > 0, `MODEL_EFFORTS["${id}"] must be non-empty`)
      for (const e of efforts) {
        assert.ok(VALID_EFFORTS.includes(e), `MODEL_EFFORTS["${id}"] has invalid effort "${e}"`)
      }
      const map = thinkingLevelMapForEfforts(efforts)
      const levels = supportedLevels({ reasoning: true, thinkingLevelMap: map })
      const expected = ALL_LEVELS.filter((l) => l === "off" || efforts.includes(l))
      assert.deepEqual(levels, expected, `model "${id}" should expose tiers matching its efforts`)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Extension registration tests (mock model endpoint)
// ────────────────────────────────────────────────────────────────────────────

describe("thinkingMetadataForModel — per-model thinking tiers", () => {
  it("exposes only supported tiers per model, and omits the map for unknowns", () => {
    const flashMeta = thinkingMetadataForModel("deepseek/deepseek-v4-flash")
    assert.ok(flashMeta, "known models must yield thinking metadata")
    const flash = {
      reasoning: true,
      thinkingLevelMap: flashMeta.thinkingLevelMap,
      thinking: flashMeta.thinking,
    }
    assert.deepEqual(supportedLevels(flash), ["off", "high", "max"])
    assert.deepEqual(flashMeta.thinking.efforts, MODEL_EFFORTS["deepseek/deepseek-v4-flash"])
    assert.equal(flashMeta.thinking.effortMap, flashMeta.thinkingLevelMap)

    // unknown model: no thinking metadata → pi default off..high
    assert.equal(thinkingMetadataForModel("some-unknown/new-model"), undefined)
    const unknownLevels = supportedLevels({ reasoning: true })
    assert.deepEqual(unknownLevels, ["off", "minimal", "low", "medium", "high"])
  })

  it("keeps the offline-loaded catalog compatible with per-model thinking maps", async () => {
    // Smoke-check that thinking metadata remains available for models discovered
    // through the post-#27 offline-capable loadCommandCodeModels path.
    const sampleBody = {
      object: "list",
      data: [
        {
          id: "deepseek/deepseek-v4-flash",
          object: "model",
          created: 1,
          owned_by: "command-code",
          name: "DeepSeek V4 Flash",
          context_length: 1_000_000,
        },
        {
          id: "some-unknown/new-model",
          object: "model",
          created: 1,
          owned_by: "command-code",
          name: "Unknown",
          context_length: 200_000,
        },
      ],
    }
    let hits = 0
    const server = createServer((_req, res) => {
      hits += 1
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(sampleBody))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      const cachePath = `/tmp/commandcode-models-thinking-levels-test.json`
      const { models } = await loadCommandCodeModels({
        url: `http://127.0.0.1:${port}/provider/v1/models`,
        cachePath,
      })
      assert.ok(hits > 0, "model fetch should hit the mock server, not the network")
      const registered = models.map((model) => ({
        id: model.id,
        reasoning: model.reasoning,
        ...(thinkingMetadataForModel(model.id) ?? {}),
      }))
      const flash = registered.find((m) => m.id === "deepseek/deepseek-v4-flash")!
      const unknown = registered.find((m) => m.id === "some-unknown/new-model")!
      assert.deepEqual(supportedLevels(flash), ["off", "high", "max"])
      assert.equal(unknown.thinkingLevelMap, undefined)
      assert.deepEqual(supportedLevels(unknown), ["off", "minimal", "low", "medium", "high"])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// reasoning_effort passthrough tests (mock generate endpoint)
// ────────────────────────────────────────────────────────────────────────────

describe("streamCommandCode — reasoning_effort passthrough", () => {
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

  it("forwards the selected effort as reasoning_effort in params", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })
    const flash = makeModel({
      reasoning: true,
      thinkingLevelMap: thinkingLevelMapForEfforts(MODEL_EFFORTS["deepseek/deepseek-v4-flash"]),
    })

    await collectEventsSafe(
      streamCommandCode(flash, makeContext(), { apiKey: "mock-key", reasoning: "max" }),
    )

    assert.ok(server.lastRequestBody(), "a request must have been sent")
    assert.equal(paramsOf(server).reasoning_effort, "max")
  })

  it("omits reasoning_effort when the level is off", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })
    const flash = makeModel({
      reasoning: true,
      thinkingLevelMap: thinkingLevelMapForEfforts(MODEL_EFFORTS["deepseek/deepseek-v4-flash"]),
    })

    await collectEventsSafe(
      streamCommandCode(flash, makeContext(), { apiKey: "mock-key", reasoning: "off" }),
    )

    assert.ok(server.lastRequestBody(), "a request must have been sent")
    assert.equal(
      "reasoning_effort" in paramsOf(server),
      false,
      "reasoning_effort must be absent for off",
    )
  })

  it("omits reasoning_effort when the level maps to null (unsupported)", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })
    // flash thinkingLevelMap has low: null — selecting low must not send it.
    const flash = makeModel({
      reasoning: true,
      thinkingLevelMap: thinkingLevelMapForEfforts(MODEL_EFFORTS["deepseek/deepseek-v4-flash"]),
    })

    await collectEventsSafe(
      streamCommandCode(flash, makeContext(), { apiKey: "mock-key", reasoning: "low" }),
    )

    assert.ok(server.lastRequestBody(), "a request must have been sent")
    assert.equal(
      paramsOf(server).reasoning_effort,
      undefined,
      "reasoning_effort must be omitted when the level maps to null",
    )
  })
})

async function collectEventsSafe(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    void _event
  }
}
