import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  commandCodeErrorMessage,
  normalizeCommandCodeErrorMessage,
  normalizeCommandCodeMessage,
} from "../src/overflow.ts"

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

  it("normalizes finalized native host errors without retaining credentials", () => {
    const message = {
      role: "assistant" as const,
      provider: "commandcode",
      stopReason: "error" as const,
      errorMessage: "Prompt token limit exceeded: api_key=private_test_secret",
    }
    const normalized = normalizeCommandCodeMessage(message)
    assert.match(normalized?.message.errorMessage ?? "", /^context_length_exceeded:/)
    assert.doesNotMatch(normalized?.message.errorMessage ?? "", /private_test_secret/)
    assert.equal(message.errorMessage, "Prompt token limit exceeded: api_key=private_test_secret")
  })

  it("extracts nested HTTP errors and preserves their status for normalization", () => {
    const error = commandCodeErrorMessage({
      error: { details: { message: "Prompt token limit exceeded" } },
      status: 400,
    })
    assert.match(normalizeCommandCodeErrorMessage(error) ?? "", /^context_length_exceeded:/)
    assert.equal(
      normalizeCommandCodeErrorMessage(
        commandCodeErrorMessage({ error: { message: "context window exceeded" }, status: 429 }),
      ),
      undefined,
    )
  })

  it("does not normalize finalized native rate-limit errors as context overflow", () => {
    assert.equal(
      normalizeCommandCodeMessage({
        role: "assistant",
        provider: "commandcode",
        stopReason: "error",
        errorMessage: "context window exceeded: status: 429",
      }),
      undefined,
    )
  })
})
