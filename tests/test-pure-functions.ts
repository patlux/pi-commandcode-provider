/**
 * Unit tests for the real pure helpers exported by src/core.ts.
 * These are hermetic: no pi runtime and no network.
 */

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  assertTextOnlyMessages,
  getApiKey,
  getEnvironmentInfo,
  mapFinishReason,
  messagesToCC,
  parseStreamEventLine,
  projectSlugFromPath,
  textContent,
  toJsonSchema,
  toolsToJson,
} from "../src/core.ts"
import { redactCommandCodeErrorText } from "../src/overflow.ts"

import { objectAt } from "./helpers.ts"

describe("getApiKey()", () => {
  it("uses COMMANDCODE_API_KEY from provided env", () => {
    assert.equal(getApiKey({ env: { COMMANDCODE_API_KEY: "env-key" }, authPaths: [] }), "env-key")
  })

  it("reads apiKey, commandcode, pi OAuth, and official CLI credential fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-auth-"))
    try {
      const first = join(dir, "first.json")
      const second = join(dir, "second.json")
      const oauth = join(dir, "oauth.json")
      const official = join(dir, "official.json")
      writeFileSync(first, JSON.stringify({ apiKey: "file-key" }))
      writeFileSync(second, JSON.stringify({ commandcode: "fallback-key" }))
      writeFileSync(
        oauth,
        JSON.stringify({
          commandcode: {
            type: "oauth",
            access: "oauth-access-key",
            refresh: "oauth-refresh-key",
            expires: Date.now() + 3600000,
          },
        }),
      )
      writeFileSync(
        official,
        JSON.stringify({
          "command-code": {
            type: "api",
            key: "official-cli-key",
          },
        }),
      )
      assert.equal(getApiKey({ env: {}, authPaths: [first, second] }), "file-key")
      assert.equal(getApiKey({ env: {}, authPaths: [second] }), "fallback-key")
      assert.equal(getApiKey({ env: {}, authPaths: [oauth] }), "oauth-access-key")
      assert.equal(getApiKey({ env: {}, authPaths: [official] }), "official-cli-key")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ignores malformed auth files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-auth-bad-"))
    try {
      const bad = join(dir, "bad.json")
      writeFileSync(bad, "not json")
      assert.equal(getApiKey({ env: {}, authPaths: [bad] }), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("uses injected homeDir for default auth paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-home-"))
    try {
      const authDir = join(dir, ".pi", "agent")
      mkdirSync(authDir, { recursive: true })
      writeFileSync(join(authDir, "auth.json"), JSON.stringify({ commandcode: "pi-key" }))
      assert.equal(getApiKey({ env: {}, homeDir: () => dir }), "pi-key")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("error redaction", () => {
  it("redacts bearer, credential, and query-string secrets", () => {
    const redacted = redactCommandCodeErrorText(
      "Bearer user_secret_value api_key=user_secret_value https://example.test/x?token=user_secret_value",
    )
    assert.doesNotMatch(redacted, /user_secret_value/)
    assert.match(redacted, /Bearer \[redacted\]/)
    assert.doesNotMatch(
      redactCommandCodeErrorText("provider returned sk-test-secret-value-1234567890"),
      /sk-test-secret-value/,
    )
  })
})

describe("projectSlugFromPath()", () => {
  it("matches the official CLI-style slug from an absolute working directory", () => {
    assert.equal(
      projectSlugFromPath("/Users/patwoz/dev/Personal/pi/pi-commandcode-provider"),
      "users-patwoz-dev-personal-pi-pi-commandcode-provider",
    )
    assert.equal(projectSlugFromPath("/repo"), "repo")
  })
})

describe("text-only image handling", () => {
  it("rejects image content for models without image support", () => {
    assert.throws(
      () =>
        assertTextOnlyMessages([
          {
            role: "user",
            content: [{ type: "image", data: "base64-data", mimeType: "image/png" }],
          },
        ]),
      /does not support image content/i,
    )
    assert.throws(
      () =>
        assertTextOnlyMessages([
          {
            role: "toolResult",
            toolCallId: "c1",
            content: [{ type: "image", data: "base64-data", mimeType: "image/png" }],
          },
        ]),
      /does not support image content/i,
    )
  })
})

describe("textContent()", () => {
  it("extracts and joins text blocks", () => {
    assert.equal(
      textContent({
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      }),
      "hello\nworld",
    )
  })

  it("extracts text while images are handled separately", () => {
    assert.equal(
      textContent({
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "x", mimeType: "image/png" },
          { type: "text", text: "world" },
        ],
      }),
      "hello\nworld",
    )
  })

  it("handles empty or missing content", () => {
    assert.equal(textContent({ content: [] }), "")
    assert.equal(textContent({}), "")
  })
})

describe("getEnvironmentInfo()", () => {
  it("returns platform, arch, and Node version", () => {
    const info = getEnvironmentInfo()
    assert.match(info, /^(darwin|linux|win32)-/)
    assert.ok(info.includes("Node.js"))
  })
})

describe("toJsonSchema()", () => {
  it("converts scalar, enum, object, optional, array, and union schema shapes", () => {
    assert.deepEqual(toJsonSchema({ kind: "string" }), { type: "string" })
    assert.deepEqual(toJsonSchema({ kind: "Number" }), { type: "number" })
    assert.deepEqual(toJsonSchema({ kind: "boolean" }), { type: "boolean" })
    assert.deepEqual(toJsonSchema({ kind: "string", enum: ["left", "right"] }), {
      type: "string",
      enum: ["left", "right"],
    })
    assert.deepEqual(
      toJsonSchema({
        kind: "object",
        properties: {
          name: { kind: "string" },
          tags: { kind: "array", items: { kind: "string" }, optional: true },
        },
      }),
      {
        type: "object",
        properties: {
          name: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["name"],
      },
    )
    assert.deepEqual(toJsonSchema({ kind: "optional", wrapped: { kind: "string" } }), {
      type: "string",
    })
    assert.deepEqual(toJsonSchema({ kind: "union", variants: [{}, { kind: "number" }] }), {
      type: "number",
    })
  })

  it("preserves explicit required arrays and handles unknown values", () => {
    assert.deepEqual(
      toJsonSchema({
        type: "object",
        properties: { name: { type: "string" }, nickname: { type: "string" } },
        required: ["name"],
      }),
      {
        type: "object",
        properties: { name: { type: "string" }, nickname: { type: "string" } },
        required: ["name"],
      },
    )
    assert.deepEqual(toJsonSchema(undefined), {})
    assert.deepEqual(toJsonSchema({ kind: "wat" }), {})
    assert.deepEqual(toJsonSchema({ type: "wat", description: "not a schema" }), {})
    assert.deepEqual(toJsonSchema({}), {})
    assert.equal(toJsonSchema(true), true)
  })

  it("preserves complete JSON Schema metadata and nested schemas", () => {
    assert.deepEqual(
      toJsonSchema({
        type: "object",
        description: "Search options",
        properties: {
          query: {
            type: "string",
            description: "Text to search for",
            minLength: 2,
            maxLength: 50,
            pattern: "^[a-z]+$",
            default: "pi",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            exclusiveMinimum: 0,
            multipleOf: 1,
            default: 10,
          },
          tags: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            items: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
        },
        required: ["query", "limit"],
        additionalProperties: false,
      }),
      {
        type: "object",
        description: "Search options",
        properties: {
          query: {
            type: "string",
            description: "Text to search for",
            minLength: 2,
            maxLength: 50,
            pattern: "^[a-z]+$",
            default: "pi",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            exclusiveMinimum: 0,
            multipleOf: 1,
            default: 10,
          },
          tags: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            items: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
        },
        required: ["query", "limit"],
        additionalProperties: false,
      },
    )
  })

  it("preserves JSON Schema composition and nullable forms", () => {
    assert.deepEqual(
      toJsonSchema({
        anyOf: [{ type: "string" }, { type: "number" }],
        oneOf: [{ const: "a" }, { const: "b" }],
        allOf: [{ minLength: 1 }, { maxLength: 10 }],
        nullable: true,
      }),
      {
        anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
        oneOf: [{ const: "a" }, { const: "b" }],
        allOf: [{ minLength: 1 }, { maxLength: 10 }],
      },
    )
    assert.deepEqual(toJsonSchema({ type: ["string", "null"] }), {
      type: ["string", "null"],
    })
    assert.deepEqual(toJsonSchema({ type: "string", nullable: true }), {
      type: ["string", "null"],
    })
  })

  it("preserves dangerous schema property names", () => {
    const inputProperties: Record<string, unknown> = {
      constructor: { type: "number" },
    }
    Object.defineProperty(inputProperties, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { type: "string" },
      writable: true,
    })
    const schema = toJsonSchema({
      type: "object",
      properties: inputProperties,
      required: ["__proto__", "constructor"],
    })
    assert.ok(schema && typeof schema === "object" && !Array.isArray(schema))
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error("expected object schema")
    }
    const outputProperties: unknown = Object.getOwnPropertyDescriptor(schema, "properties")?.value
    assert.ok(outputProperties && typeof outputProperties === "object")
    if (!outputProperties || typeof outputProperties !== "object") {
      throw new Error("expected object properties")
    }
    assert.ok(Object.prototype.hasOwnProperty.call(outputProperties, "__proto__"))
    assert.deepEqual(Object.getOwnPropertyDescriptor(outputProperties, "__proto__")?.value, {
      type: "string",
    })
    assert.deepEqual(Object.getOwnPropertyDescriptor(outputProperties, "constructor")?.value, {
      type: "number",
    })
  })

  it("converts legacy shapes without collapsing unions", () => {
    assert.deepEqual(
      toJsonSchema({
        kind: "Object",
        description: "Legacy options",
        properties: {
          mode: {
            kind: "union",
            variants: [
              { kind: "string", enum: ["fast", "safe"] },
              { kind: "string", enum: ["debug"] },
            ],
          },
          count: { kind: "Number", minimum: 1, optional: true },
          nested: {
            kind: "Array",
            element: { kind: "object", properties: { value: { kind: "boolean" } } },
          },
        },
        optional: ["count"],
        additionalProperties: false,
      }),
      {
        type: "object",
        description: "Legacy options",
        properties: {
          mode: {
            anyOf: [
              { type: "string", enum: ["fast", "safe"] },
              { type: "string", enum: ["debug"] },
            ],
          },
          count: { type: "number", minimum: 1 },
          nested: {
            type: "array",
            items: {
              type: "object",
              properties: { value: { type: "boolean" } },
              required: ["value"],
            },
          },
        },
        required: ["mode", "nested"],
        additionalProperties: false,
      },
    )
    assert.deepEqual(
      toJsonSchema({
        kind: "intersect",
        variants: [{ kind: "object", properties: { a: { kind: "string" } } }, { kind: "number" }],
      }),
      {
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "number" },
        ],
      },
    )
  })
})

describe("toolsToJson()", () => {
  it("converts pi tools to Command Code tool JSON", () => {
    assert.deepEqual(
      toolsToJson([
        {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            kind: "object",
            properties: { city: { kind: "string" } },
          },
        },
      ]),
      [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    )
  })

  it("returns an empty array for missing tools", () => {
    assert.deepEqual(toolsToJson(), [])
  })
})

describe("messagesToCC()", () => {
  it("converts user, assistant, and tool result messages", () => {
    const result = messagesToCC([
      { role: "user", content: "read /tmp/test" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I will read" },
          { type: "text", text: "Sure" },
          {
            type: "toolCall",
            id: "c1",
            name: "read",
            arguments: { path: "/tmp/test" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        isError: false,
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      },
    ])

    assert.equal(objectAt(result, ["0", "role"]), "user")
    assert.equal(objectAt(result, ["1", "role"]), "assistant")
    assert.equal(objectAt(result, ["1", "content", "0", "type"]), "text")
    assert.equal(objectAt(result, ["1", "content", "1", "type"]), "tool-call")
    assert.equal(objectAt(result, ["1", "content", "2"]), undefined)
    assert.equal(objectAt(result, ["2", "role"]), "tool")
    assert.equal(objectAt(result, ["2", "content", "0", "output", "value"]), "hello\nworld")
  })

  it("serializes image inputs in the current Command Code wire format", () => {
    assert.deepEqual(
      messagesToCC(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "inspect this" },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
          },
        ],
        { allowImages: true },
      ),
      [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect this" },
            {
              type: "image",
              image: "data:image/png;base64,aGVsbG8=",
              mimeType: "image/png",
            },
          ],
        },
      ],
    )
  })

  it("preserves tool-result images as a following user image message", () => {
    const result = messagesToCC(
      [
        { role: "user", content: "read image" },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: [
            { type: "text", text: "image attached" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
          ],
        },
      ],
      { allowImages: true },
    )

    assert.equal(objectAt(result, ["2", "role"]), "tool")
    assert.equal(objectAt(result, ["2", "content", "0", "output", "value"]), "image attached")
    assert.deepEqual(objectAt(result, ["3"]), {
      role: "user",
      content: [
        {
          type: "image",
          image: "data:image/jpeg;base64,aGVsbG8=",
          mimeType: "image/jpeg",
        },
      ],
    })
  })

  it("drops previous assistant reasoning while preserving text and tool calls", () => {
    const result = messagesToCC([
      { role: "user", content: "first question" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning from turn one" },
          { type: "text", text: "first answer" },
        ],
      },
      { role: "user", content: "follow-up question" },
    ])

    assert.deepEqual(result, [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { role: "user", content: "follow-up question" },
    ])
  })

  it("omits assistant turns that contain only previous reasoning", () => {
    const result = messagesToCC([
      { role: "user", content: "first question" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "private reasoning" }],
      },
      { role: "user", content: "follow-up question" },
    ])

    assert.deepEqual(result, [
      { role: "user", content: "first question" },
      { role: "user", content: "follow-up question" },
    ])
  })

  it("drops orphaned tool calls that have no matching tool result", () => {
    const result = messagesToCC([
      { role: "user", content: "edit a file" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will edit it" },
          {
            type: "toolCall",
            id: "missing-result",
            name: "edit",
            arguments: { path: "x" },
          },
        ],
      },
    ])

    assert.equal(objectAt(result, ["1", "role"]), "assistant")
    assert.equal(objectAt(result, ["1", "content", "0", "type"]), "text")
    assert.equal(objectAt(result, ["1", "content", "1"]), undefined)
  })

  it("handles empty conversations", () => {
    assert.deepEqual(messagesToCC([]), [])
  })
})

describe("parseStreamEventLine()", () => {
  it("parses plain JSON and SSE data lines", () => {
    assert.deepEqual(parseStreamEventLine('{"type":"text-delta","text":"x"}'), {
      type: "text-delta",
      text: "x",
    })
    assert.deepEqual(parseStreamEventLine('data: {"type":"finish","finishReason":"stop"}'), {
      type: "finish",
      finishReason: "stop",
    })
  })

  it("ignores comments, event labels, done markers, and malformed JSON", () => {
    assert.equal(parseStreamEventLine(":"), undefined)
    assert.equal(parseStreamEventLine("event: message"), undefined)
    assert.equal(parseStreamEventLine("data: [DONE]"), undefined)
    assert.equal(parseStreamEventLine("not-json"), undefined)
  })
})

describe("mapFinishReason()", () => {
  it("maps provider finish reasons to pi stop reasons", () => {
    assert.equal(mapFinishReason("stop"), "stop")
    assert.equal(mapFinishReason("tool-calls"), "toolUse")
    assert.equal(mapFinishReason("max_tokens"), "length")
    assert.equal(mapFinishReason("max_output_tokens"), "length")
  })
})
