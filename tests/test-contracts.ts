import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import { isRecord, messagesToCC } from "../src/converters.ts"
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  MessageLike,
} from "../src/types.ts"
import { createTestDeps, makeContext, makeModel } from "./helpers.ts"

// Kept inside the Go package so its exact installed tarball can run the same
// contracts. Both drivers read this one source; no generated test expectations.
const fixture: unknown = JSON.parse(
  readFileSync(
    new URL(
      "../packages/pig-commandcode-provider/extensions/pig-commandcode-provider/testdata/contracts.json",
      import.meta.url,
    ),
    "utf8",
  ),
)
assert.ok(isRecord(fixture))
assert.equal(fixture.version, 1)

function cases(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value) && value.length > 0)
  assert.ok(value.every(isRecord))
  const names = value.map((entry) => {
    assert.equal(typeof entry.name, "string")
    return entry.name
  })
  assert.equal(new Set(names).size, names.length, "duplicate contract name")
  return value
}

function isMessage(value: unknown): value is MessageLike {
  return isRecord(value) && typeof value.role === "string"
}

function wireStream(events: unknown[]): Response {
  const bytes = new TextEncoder().encode(
    ": heartbeat\nevent: message\nnot-json\n" +
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  )
  let offset = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close()
        else controller.enqueue(bytes.slice(offset, ++offset))
      },
    }),
  )
}

async function collectAll(
  stream: AssistantMessageEventStreamLike,
): Promise<AssistantMessageEvent[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const events: AssistantMessageEvent[] = []
        for await (const event of stream) events.push(event)
        return events
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("contract stream did not close")), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function terminal(events: AssistantMessageEvent[], reason: unknown) {
  assert.equal(events.filter((event) => event.type === "done" || event.type === "error").length, 1)
  const last = events.at(-1)
  assert.ok(last?.type === "done" || last?.type === "error")
  assert.equal(last.reason, reason)
  assert.equal(last.type, reason === "error" || reason === "aborted" ? "error" : "done")
  const message = last.type === "done" ? last.message : last.error
  assert.equal(message.stopReason, reason)
  return message
}

describe("shared contracts: history", () => {
  for (const entry of cases(fixture.history)) {
    it(String(entry.name), () => {
      const messages = entry.messages
      assert.ok(Array.isArray(messages) && messages.every(isMessage))
      const original = structuredClone(messages)
      const convert = () => messagesToCC(messages, { allowImages: entry.allowImages === true })
      if (typeof entry.errorContains === "string") {
        const expected = entry.errorContains
        assert.throws(
          convert,
          (error: unknown) => error instanceof Error && error.message.includes(expected),
        )
      } else {
        assert.ok(Array.isArray(entry.expected))
        assert.deepEqual(convert(), entry.expected)
      }
      assert.deepEqual(messages, original, "conversion mutated retained history")
    })
  }
})

describe("shared contracts: generate streams", () => {
  for (const entry of cases(fixture.streams)) {
    it(String(entry.name), async () => {
      assert.ok(Array.isArray(entry.events))
      const rawEvents = entry.events
      assert.ok(isRecord(entry.expected))
      const expected = entry.expected
      let requests = 0
      const { streamCommandCode } = createTestDeps({
        fetchImpl: async () => {
          requests++
          return wireStream(rawEvents)
        },
      })
      const events = await collectAll(
        streamCommandCode(makeModel(), makeContext(), {
          apiKey: "synthetic-contract-key",
          maxRetries: 2,
          maxRetryDelayMs: 1,
        }),
      )
      const message = terminal(events, expected.reason)
      assert.equal(requests, 1, "stream must not be replayed")
      if (expected.content !== undefined) assert.deepEqual(message.content, expected.content)
      if (expected.eventTypes !== undefined)
        assert.deepEqual(
          events.map((event) => event.type),
          expected.eventTypes,
        )
      if (expected.toolEnds !== undefined)
        assert.equal(
          events.filter((event) => event.type === "toolcall_end").length,
          expected.toolEnds,
        )
      if (typeof expected.errorContains === "string")
        assert.ok(message.errorMessage?.includes(expected.errorContains), message.errorMessage)
      if (isRecord(expected.usage)) {
        const { cost: _cost, ...tokens } = message.usage
        assert.deepEqual(tokens, expected.usage)
      }
    })
  }
})

describe("shared contracts: HTTP retries", () => {
  for (const entry of cases(fixture.retries)) {
    it(String(entry.name), async () => {
      assert.equal(typeof entry.status, "number")
      assert.equal(typeof entry.retryAfter, "string")
      assert.equal(typeof entry.maxRetries, "number")
      assert.equal(typeof entry.maxRetryDelayMs, "number")
      const { status, retryAfter, maxRetries, maxRetryDelayMs } = entry
      assert.ok(
        typeof status === "number" &&
          typeof retryAfter === "string" &&
          typeof maxRetries === "number" &&
          typeof maxRetryDelayMs === "number",
      )
      let requests = 0
      const { streamCommandCode } = createTestDeps({
        fetchImpl: async () =>
          ++requests === 1
            ? new Response("synthetic failure", { status, headers: { "Retry-After": retryAfter } })
            : wireStream([{ type: "finish", finishReason: "stop" }]),
      })
      const events = await collectAll(
        streamCommandCode(makeModel(), makeContext(), {
          apiKey: "synthetic-contract-key",
          maxRetries,
          maxRetryDelayMs,
        }),
      )
      terminal(events, entry.reason)
      assert.equal(requests, entry.requests)
    })
  }
})
