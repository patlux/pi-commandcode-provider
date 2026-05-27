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

  it("uses injected homeDir for pi default auth paths", () => {
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

  it("uses injected homeDir for OMP default auth paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-omp-home-"))
    try {
      const authDir = join(dir, ".omp", "agent")
      mkdirSync(authDir, { recursive: true })
      writeFileSync(join(authDir, "auth.json"), JSON.stringify({ commandcode: "omp-key" }))
      assert.equal(getApiKey({ env: {}, homeDir: () => dir }), "omp-key")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

describe("textContent()", () => {
  it("extracts and joins text blocks", () => {
    assert.equal(
      textContent({
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "x" },
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
    assert.equal(objectAt(result, ["1", "content", "0", "type"]), "reasoning")
    assert.equal(objectAt(result, ["1", "content", "2", "type"]), "tool-call")
    assert.equal(objectAt(result, ["2", "role"]), "tool")
    assert.equal(objectAt(result, ["2", "content", "0", "output", "value"]), "hello\nworld")
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
