import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it } from "node:test"

import {
  commandCodeErrorMessage,
  normalizeCommandCodeErrorMessage,
  normalizeCommandCodeMessage,
} from "../src/overflow.ts"
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

describe("Command Code overflow normalization", () => {
  it("normalizes Command Code context errors to pi's generic overflow marker", () => {
    const normalized = normalizeCommandCodeErrorMessage("Prompt token limit exceeded")

    assert.equal(normalized, "context_length_exceeded: Prompt token limit exceeded")
  })

  it("is idempotent and leaves unrelated, rate-limit, and capacity errors unchanged", () => {
    assert.equal(
      normalizeCommandCodeErrorMessage("context_length_exceeded: Prompt token limit exceeded"),
      undefined,
    )
    assert.equal(normalizeCommandCodeErrorMessage("OpenAI request failed"), undefined)
    assert.equal(
      normalizeCommandCodeErrorMessage("Prompt token limit exceeded due to rate limit"),
      undefined,
    )
    assert.equal(
      normalizeCommandCodeErrorMessage("Command Code API error 429: context window exceeded"),
      undefined,
    )
    assert.equal(
      normalizeCommandCodeErrorMessage("context window exceeded: status: 429"),
      undefined,
    )
    assert.equal(
      normalizeCommandCodeErrorMessage("The input is too long"),
      "context_length_exceeded: The input is too long",
    )
    assert.equal(
      normalizeCommandCodeErrorMessage("Input exceeds context limit"),
      "context_length_exceeded: Input exceeds context limit",
    )
    assert.equal(
      normalizeCommandCodeErrorMessage("Context window exceeded: provider capacity reached"),
      undefined,
    )
  })

  it("redacts direct string errors in the stream-error extraction helper", () => {
    assert.equal(
      commandCodeErrorMessage("context window exceeded: api_key=direct_secret_value"),
      "context window exceeded: api_key=[redacted]",
    )
  })

  it("redacts secrets before exposing normalized context overflow errors", () => {
    assert.equal(
      normalizeCommandCodeErrorMessage("Prompt token limit exceeded: api_key=overflow_secret"),
      "context_length_exceeded: Prompt token limit exceeded: api_key=[redacted]",
    )

    const normalized = normalizeCommandCodeMessage({
      role: "assistant",
      provider: "commandcode",
      stopReason: "error",
      errorMessage: "Prompt token limit exceeded: api_key=overflow_secret",
    })
    assert.equal(
      normalized?.message.errorMessage,
      "context_length_exceeded: Prompt token limit exceeded: api_key=[redacted]",
    )
  })

  it("scopes finalized message normalization to Command Code", () => {
    const message = {
      role: "assistant" as const,
      provider: "commandcode",
      stopReason: "error" as const,
      errorMessage: "model context window exceeded",
    }

    const normalized = normalizeCommandCodeMessage(message)
    assert.equal(
      normalized?.message.errorMessage,
      "context_length_exceeded: model context window exceeded",
    )
    assert.equal(normalizeCommandCodeMessage({ ...message, provider: "openai" }), undefined)
    assert.equal(normalizeCommandCodeMessage({ ...message, stopReason: "stop" }), undefined)
  })

  it("extracts nested stream error messages without exposing credentials", () => {
    assert.equal(
      commandCodeErrorMessage({
        error: { details: { errorMessage: "context window exceeded" } },
      }),
      "context window exceeded",
    )
  })

  it("redacts secrets from finalized provider errors", async () => {
    server.mockResponse({
      type: "error",
      status: 400,
      body: "api_key=user_secret_value",
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.doesNotMatch(error.error.errorMessage ?? "", /user_secret_value/)
    assert.match(error.error.errorMessage ?? "", /api_key=\[redacted\]/)
  })

  it("normalizes HTTP error bodies containing nested context errors", async () => {
    server.mockResponse({
      type: "error",
      status: 400,
      body: JSON.stringify({ error: { message: "Prompt token limit exceeded" } }),
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )
    const error = events.at(-1)

    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    const normalized = normalizeCommandCodeMessage(error.error)
    assert.match(normalized?.message.errorMessage ?? "", /^context_length_exceeded:/)
  })

  it("does not normalize an HTTP rate-limit response that mentions context", async () => {
    server.mockResponse({
      type: "error",
      status: 429,
      body: JSON.stringify({ error: { message: "context window exceeded" } }),
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: "mock-key" }),
    )
    const error = events.at(-1)

    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(normalizeCommandCodeMessage(error.error), undefined)
  })

  it("normalizes nested stream error events", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({
          type: "error",
          error: { details: { message: "model context window exceeded" } },
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
    const normalized = normalizeCommandCodeMessage(error.error)
    assert.equal(
      normalized?.message.errorMessage,
      "context_length_exceeded: model context window exceeded",
    )

    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({
          type: "error",
          error: { message: "context window exceeded", status: 429 },
        }),
      ],
    })
    const retryEvents = await collectEvents(
      createTestDeps({ apiBase: server.baseUrl() }).streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
      }),
    )
    const retryError = retryEvents.at(-1)
    assert.equal(retryError?.type, "error")
    if (retryError?.type !== "error") throw new Error("expected error")
    assert.equal(normalizeCommandCodeMessage(retryError.error), undefined)
  })
})
