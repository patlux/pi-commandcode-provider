import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { normalizeCommandCodeResponsesResponse } from "../src/responses-stream.ts"
import { createCommandCodeTransportRouter } from "../src/transport.ts"
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  StreamOptions,
} from "../src/types.ts"
import { collectEvents, createTestEventStream, makeContext, makeModel } from "./helpers.ts"

function completedStream(text: string): AssistantMessageEventStreamLike {
  const stream = createTestEventStream()
  const model = makeModel()
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  }
  const events: AssistantMessageEvent[] = [
    { type: "start", partial: message },
    { type: "text_start", contentIndex: 0, partial: message },
    { type: "text_delta", contentIndex: 0, delta: text, partial: message },
    { type: "text_end", contentIndex: 0, content: text, partial: message },
    { type: "done", reason: "stop", message },
  ]
  for (const event of events) stream.push(event)
  stream.end()
  return stream
}

function providerStream(
  response: Response,
  text: string,
  options?: StreamOptions,
): AssistantMessageEventStreamLike {
  const stream = createTestEventStream()
  const run = async () => {
    const received = await (options?.fetch ?? fetch)("https://provider.test", {})
    await options?.onResponse?.(
      { status: received.status, headers: {} },
      makeModel({ api: "openai-completions" }),
    )
    const source = completedStream(text)
    for await (const event of source) stream.push(event)
    stream.end()
  }
  run().catch(() => stream.end())
  return stream
}

describe("Command Code transport router", () => {
  it("keeps using the Provider API after a successful request", async () => {
    let providerCalls = 0
    let generateCalls = 0
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        return providerStream(new Response("ok", { status: 200 }), "provider", options)
      },
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })

    const options: StreamOptions = {
      fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
    }
    const first = await collectEvents(router.stream(makeModel(), makeContext(), options))
    const second = await collectEvents(router.stream(makeModel(), makeContext(), options))

    assert.equal(first.at(-1)?.type, "done")
    assert.equal(second.at(-1)?.type, "done")
    assert.equal(router.getTransport(), "provider")
    assert.equal(providerCalls, 2)
    assert.equal(generateCalls, 0)
  })

  it("falls back only for 403 upgrade_required and remembers generate", async () => {
    let providerCalls = 0
    let generateCalls = 0
    const responseBody = JSON.stringify({
      error: { code: "upgrade_required", type: "permission_error" },
    })
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        return providerStream(new Response(responseBody, { status: 403 }), "blocked", options)
      },
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })
    const options: StreamOptions = {
      fetch: () => Promise.resolve(new Response(responseBody, { status: 403 })),
    }

    const first = await collectEvents(router.stream(makeModel(), makeContext(), options))
    const second = await collectEvents(router.stream(makeModel(), makeContext(), options))

    assert.equal(first.at(-1)?.type, "done")
    assert.equal(second.at(-1)?.type, "done")
    assert.equal(router.getTransport(), "generate")
    assert.equal(providerCalls, 1)
    assert.equal(generateCalls, 2)
  })

  it("re-detects the transport after the API key changes", async () => {
    let providerCalls = 0
    let generateCalls = 0
    const upgradeBody = JSON.stringify({ error: { code: "upgrade_required" } })
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        const response =
          options?.apiKey === "go-key"
            ? new Response(upgradeBody, { status: 403 })
            : new Response("ok", { status: 200 })
        return providerStream(response, "provider", options)
      },
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })

    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "go-key",
        fetch: () => Promise.resolve(new Response(upgradeBody, { status: 403 })),
      }),
    )
    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "provider-key",
        fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
      }),
    )

    assert.equal(router.getTransport(), "provider")
    assert.equal(providerCalls, 2)
    assert.equal(generateCalls, 1)
  })

  it("does not let a stale request overwrite the transport for a new API key", async () => {
    let releaseGoRequest: (() => void) | undefined
    const goRequestGate = new Promise<void>((resolve) => {
      releaseGoRequest = resolve
    })
    let providerCalls = 0
    let generateCalls = 0
    const upgradeBody = JSON.stringify({ error: { code: "upgrade_required" } })
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        const response =
          options?.apiKey === "go-key"
            ? new Response(upgradeBody, { status: 403 })
            : new Response("ok", { status: 200 })
        const stream = createTestEventStream()
        const run = async () => {
          if (options?.apiKey === "go-key") await goRequestGate
          const received = await (options?.fetch ?? fetch)("https://provider.test", {})
          await options?.onResponse?.(
            { status: received.status, headers: {} },
            makeModel({ api: "openai-completions" }),
          )
          if (response.ok) {
            for await (const event of completedStream("provider")) stream.push(event)
          }
          stream.end()
        }
        run().catch(() => stream.end())
        return stream
      },
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })

    const staleGoRequest = collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "go-key",
        fetch: () => Promise.resolve(new Response(upgradeBody, { status: 403 })),
      }),
    )
    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "provider-key",
        fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
      }),
    )
    releaseGoRequest?.()
    await staleGoRequest
    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "provider-key",
        fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
      }),
    )

    assert.equal(router.getTransport(), "provider")
    assert.equal(providerCalls, 3)
    assert.equal(generateCalls, 1)
  })

  it("does not fall back for other 403 errors", async () => {
    let generateCalls = 0
    const responseBody = JSON.stringify({ error: { code: "permission_denied" } })
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) =>
        providerStream(new Response(responseBody, { status: 403 }), "blocked", options),
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })
    const options: StreamOptions = {
      fetch: () => Promise.resolve(new Response(responseBody, { status: 403 })),
    }

    await collectEvents(router.stream(makeModel(), makeContext(), options))

    assert.equal(router.getTransport(), "provider")
    assert.equal(generateCalls, 0)
  })
})

const encoder = new TextEncoder()

function sseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "text/event-stream; charset=utf-8", ...extra }
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
  let output = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    output += decoder.decode(value, { stream: true })
  }
  output += decoder.decode()
  return output
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 2_000,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`read timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ])
}

function findBytes(haystack: Uint8Array, needle: readonly number[]): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

describe("Command Code Responses stream normalizer", () => {
  it("emits the canonical event incrementally across split chunks", async () => {
    const event = {
      type: "response.reasoning.delta",
      output_index: 0,
      content_index: 0,
      item_id: "rs_1",
      delta: "наб",
    }
    const frame = `event: response.reasoning.delta\ndata: ${JSON.stringify(event)}\n\n`
    const bytes = encoder.encode(frame)
    const typeSplit = findBytes(bytes, [0x72, 0x65, 0x61, 0x73, 0x6f, 0x6e]) + 4
    // Land inside the first Cyrillic character so the decoder must buffer bytes.
    const charSplit = findBytes(bytes, [0xd0, 0xbd]) + 1

    let sourceController!: ReadableStreamDefaultController<Uint8Array>
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller
      },
    })
    const response = new Response(source, { status: 200, headers: sseHeaders() })
    const normalized = normalizeCommandCodeResponsesResponse(response)
    assert.notEqual(normalized, response)
    const reader = normalized.body!.getReader()

    sourceController.enqueue(bytes.slice(0, typeSplit))
    sourceController.enqueue(bytes.slice(typeSplit, charSplit))
    sourceController.enqueue(bytes.slice(charSplit))

    const first = await readWithTimeout(reader)
    assert.equal(first.done, false)
    const text = new TextDecoder().decode(first.value)
    assert.match(text, /^event: response\.reasoning_text\.delta\n/)
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "))
    assert.ok(dataLine, `missing data line in ${JSON.stringify(text)}`)
    const parsed = JSON.parse(dataLine.slice("data: ".length))
    assert.equal(parsed.type, "response.reasoning_text.delta")
    assert.equal(parsed.delta, "наб")
    assert.equal(parsed.item_id, "rs_1")
    assert.equal(parsed.output_index, 0)
    assert.equal(parsed.content_index, 0)

    // The upstream response is still open, yet the delta was already emitted.
    sourceController.close()
    const end = await readWithTimeout(reader)
    assert.equal(end.done, true)
  })

  it("preserves a leading BOM when rewriting event or data lines", async () => {
    const alias = { type: "response.reasoning.delta", output_index: 0, delta: "hi" }
    const canonical = { ...alias, type: "response.reasoning_text.delta" }
    for (const includeEvent of [false, true]) {
      const input =
        "\uFEFF" +
        (includeEvent ? "event: response.reasoning.delta\n" : "") +
        `data: ${JSON.stringify(alias)}\n\n`
      const expected =
        "\uFEFF" +
        (includeEvent ? "event: response.reasoning_text.delta\n" : "") +
        `data: ${JSON.stringify(canonical)}\n\n`
      const response = new Response(input, { headers: sseHeaders() })
      assert.equal(await readAll(normalizeCommandCodeResponsesResponse(response)), expected)
    }
  })

  it("recognizes LF, CRLF, and CR boundaries and merges split data", async () => {
    const split = (json: string): [string, string] => [json.slice(0, 1), json.slice(1)]
    for (const ending of ["\n", "\r\n", "\r"]) {
      const alias = { type: "response.reasoning.delta", output_index: 0, delta: "hi" }
      const canonical = {
        type: "response.reasoning_text.delta",
        output_index: 1,
        delta: "yo",
        item_id: "rs_2",
      }
      const [head, tail] = split(JSON.stringify(alias))
      const frame =
        `event: response.reasoning.delta${ending}` +
        `data: ${head}${ending}` +
        `data: ${tail}${ending}${ending}` +
        `data: ${JSON.stringify(canonical)}${ending}${ending}`

      // Split the first CRLF pair across two chunks so the scanner must wait.
      const firstCrlf = frame.indexOf("\r\n")
      const chunks =
        ending === "\r\n" && firstCrlf !== -1
          ? [frame.slice(0, firstCrlf + 1), frame.slice(firstCrlf + 1)]
          : [frame]

      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      })
      const response = new Response(source, { status: 200, headers: sseHeaders() })
      const output = await readAll(normalizeCommandCodeResponsesResponse(response))

      assert.equal(output.split("response.reasoning.delta").length - 1, 0, output)
      assert.equal(output.split("response.reasoning_text.delta").length - 1, 3, output)
      assert.ok(output.includes('"delta":"hi"'), output)
      assert.ok(output.includes(JSON.stringify(canonical)), output)
    }
  })

  it("leaves standard and malformed frames untouched", async () => {
    const aliasInDelta = {
      type: "response.output_text.delta",
      output_index: 0,
      delta: "response.reasoning.delta",
    }
    const input =
      `data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "x" })}\n\n` +
      `data: ${JSON.stringify({ type: "response.reasoning.done", output_index: 0, text: "t" })}\n\n` +
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs", content: [] } })}\n\n` +
      `data: ${JSON.stringify(aliasInDelta)}\n\n` +
      `: keep this comment\n\n` +
      `data: [DONE]\n\n` +
      `data: {not json\n\n` +
      `data: ${JSON.stringify({ type: "response.reasoning.delta", output_index: 0 })}\n\n` +
      `data: ${JSON.stringify({ type: "response.reasoning.delta", output_index: -1, delta: "x" })}\n\n`

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(input))
        controller.close()
      },
    })
    const response = new Response(source, { status: 200, headers: sseHeaders() })
    const output = await readAll(normalizeCommandCodeResponsesResponse(response))
    assert.equal(output, input)
  })

  it("returns non-SSE responses unchanged without reading the body", async () => {
    const errorResponse = new Response("nope", { status: 500 })
    assert.equal(normalizeCommandCodeResponsesResponse(errorResponse), errorResponse)

    const noBody = new Response(null, { status: 200 })
    assert.equal(noBody.body, null)
    assert.equal(normalizeCommandCodeResponsesResponse(noBody), noBody)

    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(encoder.encode("{}"))
        controller.close()
      },
    })
    const jsonResponse = new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })
    assert.equal(normalizeCommandCodeResponsesResponse(jsonResponse), jsonResponse)
    assert.equal(pulled, 0)
  })

  it("preserves status and request metadata while dropping body-encoding headers", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    })
    const response = new Response(source, {
      status: 200,
      headers: sseHeaders({
        "request-id": "req_123",
        "content-length": "999",
        "content-encoding": "gzip",
      }),
    })
    const normalized = normalizeCommandCodeResponsesResponse(response)
    assert.equal(normalized.status, 200)
    assert.equal(normalized.statusText, response.statusText)
    assert.equal(normalized.headers.get("request-id"), "req_123")
    assert.equal(normalized.headers.get("content-length"), null)
    assert.equal(normalized.headers.get("content-encoding"), null)
  })

  it("propagates cancellation to the source stream", async () => {
    let resolveCancel!: (reason: unknown) => void
    const cancelled = new Promise<unknown>((resolve) => {
      resolveCancel = resolve
    })
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {}\n\n"))
      },
      cancel(reason) {
        resolveCancel(reason)
      },
    })
    const response = new Response(source, { status: 200, headers: sseHeaders() })
    const reader = normalizeCommandCodeResponsesResponse(response).body!.getReader()
    await readWithTimeout(reader)
    await reader.cancel("stop")

    const reason = await Promise.race([
      cancelled,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("source was not cancelled")), 2_000),
      ),
    ])
    assert.equal(reason, "stop")
  })

  it("surfaces an input stream error instead of a clean end", async () => {
    const failure = new Error("boom")
    let first = true
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) {
          first = false
          controller.enqueue(encoder.encode("data: {}\n\n"))
          return
        }
        controller.error(failure)
      },
    })
    const response = new Response(source, { status: 200, headers: sseHeaders() })
    const reader = normalizeCommandCodeResponsesResponse(response).body!.getReader()
    const chunk = await readWithTimeout(reader)
    assert.equal(chunk.done, false)
    await assert.rejects(readWithTimeout(reader), /boom/)
  })
})
