/** Hermetic tests for the Responses wire repairs (issues #214 and the Mistral case). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  RESPONSES_WIRE_REPAIRS,
  rewriteResponsesBody,
  withResponsesWireRepairs,
} from "../src/responses-compat.ts"

/** A body shaped like the one pi-ai sends: leading system item then a user turn. */
function responsesBody(model = "zai-org/GLM-5.3", extra: Record<string, unknown> = {}) {
  return {
    model,
    input: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: [{ type: "input_text", text: "hey" }] },
    ],
    stream: true,
    store: false,
    ...extra,
  }
}

const parse = (body: string) => JSON.parse(body) as Record<string, unknown>

describe("RESPONSES_WIRE_REPAIRS", () => {
  it("lists exactly the models proven to need a repair", () => {
    assert.deepEqual(Object.keys(RESPONSES_WIRE_REPAIRS).sort(), [
      "mistral/mistral-large-4",
      "zai-org/GLM-5.3",
    ])
    assert.deepEqual(RESPONSES_WIRE_REPAIRS["zai-org/GLM-5.3"], {
      messageItemType: true,
      dropNoneEffort: true,
    })
    // Mistral answers the shorthand fine; only its effort value is refused.
    assert.deepEqual(RESPONSES_WIRE_REPAIRS["mistral/mistral-large-4"], { dropNoneEffort: true })
  })
})

describe("rewriteResponsesBody() — message item type", () => {
  it("tags the system and user items and leaves typed items byte-identical", () => {
    const body = responsesBody()
    body.input.push(
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      } as never,
      { type: "function_call", call_id: "c1", name: "bash", arguments: "{}" } as never,
    )
    const rewritten = parse(rewriteResponsesBody(JSON.stringify(body)))
    const input = rewritten.input as Record<string, unknown>[]
    assert.deepEqual(input[0], {
      type: "message",
      role: "system",
      content: "You are a coding agent.",
    })
    assert.deepEqual(input[1], {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hey" }],
    })
    assert.deepEqual(input.slice(2), body.input.slice(2))
  })

  it("is idempotent", () => {
    const once = rewriteResponsesBody(JSON.stringify(responsesBody()))
    assert.equal(rewriteResponsesBody(once), once)
  })

  it("skips role-carrying items without content and non-message roles", () => {
    const body = { model: "zai-org/GLM-5.3", input: [{ role: "user" }, { role: "tool" }] }
    assert.equal(rewriteResponsesBody(JSON.stringify(body)), JSON.stringify(body))
  })
})

describe("rewriteResponsesBody() — inert reasoning", () => {
  it("drops reasoning when it only says effort none", () => {
    const body = responsesBody("zai-org/GLM-5.3", { reasoning: { effort: "none" } })
    const rewritten = parse(rewriteResponsesBody(JSON.stringify(body)))
    assert.equal("reasoning" in rewritten, false)
    assert.equal(rewritten.model, "zai-org/GLM-5.3")
  })

  it("keeps reasoning blocks that carry a real effort or extra fields", () => {
    for (const reasoning of [{ effort: "low" }, { effort: "none", summary: "auto" }, {}]) {
      const body = { model: "mistral/mistral-large-4", input: [], reasoning }
      assert.equal(rewriteResponsesBody(JSON.stringify(body)), JSON.stringify(body))
    }
  })

  it("drops the field for Mistral while leaving its input items untagged", () => {
    const body = responsesBody("mistral/mistral-large-4", { reasoning: { effort: "none" } })
    const rewritten = parse(rewriteResponsesBody(JSON.stringify(body)))
    assert.equal("reasoning" in rewritten, false)
    assert.deepEqual(rewritten.input, body.input)
  })

  it("applies both repairs together for GLM-5.3", () => {
    const body = responsesBody("zai-org/GLM-5.3", { reasoning: { effort: "none" } })
    const rewritten = parse(rewriteResponsesBody(JSON.stringify(body)))
    assert.equal("reasoning" in rewritten, false)
    assert.equal((rewritten.input as Record<string, unknown>[])[0].type, "message")
  })
})

describe("rewriteResponsesBody() — safety", () => {
  it("leaves unlisted models byte-identical", () => {
    for (const model of ["deepseek/deepseek-v4.1-flash", "google/gemini-4-carbon", "gpt-6-sol"]) {
      const body = JSON.stringify(responsesBody(model, { reasoning: { effort: "none" } }))
      assert.equal(rewriteResponsesBody(body), body)
    }
  })

  it("keeps malformed or unexpected bodies untouched", () => {
    for (const body of ["", "not json", "[]", "null", "42", JSON.stringify({ input: [] })]) {
      assert.equal(rewriteResponsesBody(body), body)
    }
  })

  it("accepts an explicit repair table so the policy is testable", () => {
    const body = JSON.stringify(responsesBody("deepseek/deepseek-v4.1-flash"))
    const rewritten = parse(
      rewriteResponsesBody(body, { "deepseek/deepseek-v4.1-flash": { messageItemType: true } }),
    )
    assert.equal((rewritten.input as Record<string, unknown>[])[0].type, "message")
  })
})

describe("withResponsesWireRepairs()", () => {
  it("rewrites a serialized body and drops the stale content-length", () => {
    const body = JSON.stringify(responsesBody())
    const args = withResponsesWireRepairs([
      "https://api.commandcode.ai/provider/v1/responses",
      {
        method: "POST",
        body,
        headers: { "content-type": "application/json", "content-length": String(body.length) },
      },
    ])
    const init = args[1] as RequestInit
    assert.equal(args[0], "https://api.commandcode.ai/provider/v1/responses")
    assert.equal(init.method, "POST")
    assert.equal(new Headers(init.headers).get("content-length"), null)
    assert.equal(new Headers(init.headers).get("content-type"), "application/json")
    assert.equal((parse(init.body as string).input as Record<string, unknown>[])[0].type, "message")
  })

  it("passes everything else through by identity", () => {
    const untouched = [
      ["https://example.test", { method: "POST" }],
      [
        "https://example.test",
        { method: "POST", body: JSON.stringify(responsesBody("deepseek/x")) },
      ],
      ["https://example.test", { method: "POST", body: new Uint8Array([1, 2, 3]) }],
      ["https://example.test", { method: "POST", body: "not json" }],
    ] as unknown as Parameters<typeof fetch>[]
    for (const args of untouched) {
      const result = withResponsesWireRepairs(args)
      assert.equal(result[0], args[0])
      assert.equal(result[1], args[1])
    }
  })
})
