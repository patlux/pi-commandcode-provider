// Persistence and model constraints carried forward from #158 by @patlux;
// recovery, prototype safety and per-wire compatibility hardened during the carry.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import type { CommandCodeModel } from "../src/models.ts"
import {
  compatForEndpoint,
  endpointChoiceForModel,
  isEndpointChoice,
  loadEndpointOverrides,
  parseEndpointOverrides,
  resolveEndpoint,
  saveEndpointChoice,
} from "../src/routing.ts"

const model: CommandCodeModel = {
  id: "zai-org/GLM-5.3",
  name: "GLM",
  api: "openai-responses",
  reasoning: true,
  contextWindow: 1000000,
  maxTokens: 65536,
}
async function isolated(run: (path: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cc-routing-"))
  try {
    await run(join(dir, "commandcode-routing.json"), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("persistent endpoint choices", () => {
  it("uses the catalog by default and isolates each model choice", () => {
    assert.equal(resolveEndpoint(model, {}), "openai-responses")
    assert.equal(resolveEndpoint(model, { [model.id]: "chat-completions" }), "openai-completions")
    assert.equal(
      resolveEndpoint({ ...model, id: "meta/muse-spark-1.3" }, { [model.id]: "chat-completions" }),
      "openai-responses",
    )
    assert.equal(resolveEndpoint({ ...model, api: "openai-completions" }, {}), "openai-completions")
    assert.equal(resolveEndpoint(model, { [model.id]: "responses" }), "openai-responses")
  })
  it("rejects unsupported Responses and non-auto Claude choices", () => {
    assert.throws(
      () => resolveEndpoint({ ...model, api: "openai-completions" }, { [model.id]: "responses" }),
      /does not advertise/,
    )
    for (const choice of ["responses", "chat-completions"] as const) {
      assert.throws(
        () => resolveEndpoint({ ...model, api: "anthropic-messages" }, { [model.id]: choice }),
        /Claude/,
      )
    }
    assert.equal(
      resolveEndpoint({ ...model, api: "anthropic-messages" }, { [model.id]: "auto" }),
      "anthropic-messages",
    )
  })
  it("ignores inherited override properties, including prototype-name model IDs", () => {
    for (const id of ["constructor", "toString", "__proto__"]) {
      assert.equal(resolveEndpoint({ ...model, id }, {}), "openai-responses")
      assert.equal(endpointChoiceForModel(id, {}), "auto")
    }
    const inherited = Object.create({ [model.id]: "chat-completions" })
    assert.equal(resolveEndpoint(model, inherited), "openai-responses")
    const own = parseEndpointOverrides(
      JSON.parse('{"version":1,"models":{"__proto__":"chat-completions"}}'),
    )
    assert.equal(resolveEndpoint({ ...model, id: "__proto__" }, own), "openai-completions")
    assert.equal(Object.getPrototypeOf(own), Object.prototype)
  })
  it("normalizes explicit auto and rejects padded IDs instead of accepting ineffective choices", () => {
    assert.deepEqual(
      parseEndpointOverrides({ version: 1, models: { foo: "auto", bar: "responses" } }),
      { bar: "responses" },
    )
    for (const id of ["", " ", " foo", "foo "]) {
      assert.throws(() => parseEndpointOverrides({ version: 1, models: { [id]: "responses" } }))
    }
  })
  it("validates version and shapes without trusting inherited schema properties", () => {
    for (const value of [
      null,
      [],
      {},
      { version: 2, models: {} },
      { version: 1, models: [] },
      { version: 1, models: null },
      { version: 1, models: { foo: "private-invalid-choice" } },
      Object.create({ version: 1, models: {} }),
    ]) {
      assert.throws(() => parseEndpointOverrides(value))
    }
    assert.equal(isEndpointChoice("auto"), true)
    assert.equal(isEndpointChoice("chat-completions"), true)
    assert.equal(isEndpointChoice("responses"), true)
    assert.equal(isEndpointChoice("openai-responses"), false)
  })
  it("persists across loads and catalog replacement; auto removes only one choice", async () =>
    isolated(async (path, dir) => {
      assert.deepEqual(await loadEndpointOverrides(path), {})
      await saveEndpointChoice(path, "other", "responses")
      await saveEndpointChoice(path, model.id, "chat-completions")
      assert.equal(
        resolveEndpoint({ ...model }, await loadEndpointOverrides(path)),
        "openai-completions",
      )
      const saved = await saveEndpointChoice(path, model.id, "auto")
      assert.deepEqual(saved, { overrides: { other: "responses" } })
      assert.deepEqual(await loadEndpointOverrides(path), { other: "responses" })
      assert.deepEqual(await readdir(dir), ["commandcode-routing.json"])
      if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600)
    }))
  it("round-trips own prototype-name choices and removes them safely", async () =>
    isolated(async (path) => {
      for (const id of ["__proto__", "constructor", "toString"])
        await saveEndpointChoice(path, id, "chat-completions")
      const overrides = await loadEndpointOverrides(path)
      assert.equal(Object.getPrototypeOf(overrides), Object.prototype)
      for (const id of ["__proto__", "constructor", "toString"]) {
        assert.equal(endpointChoiceForModel(id, overrides), "chat-completions")
        await saveEndpointChoice(path, id, "auto")
      }
      assert.deepEqual(await loadEndpointOverrides(path), {})
    }))
  it("reads a malformed file without rewriting it; explicit repair keeps a private exact backup", async () =>
    isolated(async (path, dir) => {
      const raw = '{"secret":"synthetic-private-content", broken'
      await writeFile(path, raw)
      const before = await stat(path)
      await assert.rejects(
        loadEndpointOverrides(path),
        (error: unknown) =>
          error instanceof Error &&
          /commandcode-routing\.json/.test(error.message) &&
          !error.message.includes("synthetic-private-content") &&
          !error.message.includes(dir),
      )
      assert.equal(await readFile(path, "utf8"), raw)
      assert.equal((await stat(path)).mtimeMs, before.mtimeMs)
      assert.deepEqual(await readdir(dir), ["commandcode-routing.json"])
      const saved = await saveEndpointChoice(path, model.id, "chat-completions")
      assert.match(saved.backupFile!, /^commandcode-routing\.json\.invalid-[\w-]+\.bak$/)
      const backup = join(dir, saved.backupFile!)
      assert.equal(await readFile(backup, "utf8"), raw)
      assert.deepEqual(await loadEndpointOverrides(path), { [model.id]: "chat-completions" })
      assert.equal((await readdir(dir)).length, 2)
      if (process.platform !== "win32") {
        assert.equal((await stat(backup)).mode & 0o777, 0o600)
        assert.equal((await stat(path)).mode & 0o777, 0o600)
      }
    }))
  it("auto explicitly repairs a schema-invalid file and does not repeat backups on later commands", async () =>
    isolated(async (path, dir) => {
      await writeFile(path, JSON.stringify({ version: 1, models: { x: "invalid" } }))
      const saved = await saveEndpointChoice(path, model.id, "auto")
      assert.ok(saved.backupFile)
      assert.deepEqual(saved.overrides, {})
      assert.deepEqual(await loadEndpointOverrides(path), {})
      assert.equal((await saveEndpointChoice(path, "other", "responses")).backupFile, undefined)
      assert.equal((await readdir(dir)).length, 2)
    }))
  it("preserves malformed non-UTF8 contents byte-for-byte during explicit repair", async () =>
    isolated(async (path, dir) => {
      const raw = Buffer.from([0xff, 0xfe, 0x7b])
      await writeFile(path, raw)
      await assert.rejects(loadEndpointOverrides(path))
      const saved = await saveEndpointChoice(path, model.id, "auto")
      assert.ok(saved.backupFile)
      assert.deepEqual(await readFile(join(dir, saved.backupFile)), raw)
      assert.deepEqual(await loadEndpointOverrides(path), {})
    }))
  it("does not overwrite an unreadable file and sanitizes OS errors", async () =>
    isolated(async (path, dir) => {
      // A directory produces EISDIR even under root, unlike a chmod permission test.
      await mkdir(path)
      await assert.rejects(
        saveEndpointChoice(path, model.id, "auto"),
        (error: unknown) =>
          error instanceof Error &&
          /Could not read commandcode-routing/.test(error.message) &&
          !error.message.includes(dir),
      )
      assert.equal((await stat(path)).isDirectory(), true)
      assert.deepEqual(await readdir(dir), ["commandcode-routing.json"])
    }))
  it("rejects invalid direct writes before touching the filesystem", async () =>
    isolated(async (path, dir) => {
      await assert.rejects(saveEndpointChoice(path, " bad ", "auto"))
      assert.deepEqual(await readdir(dir), [])
    }))
  it("preserves same-wire host/user compatibility without recomputing it", () => {
    for (const wire of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
      const host = {
        commandCodeWire: wire,
        maxTokensField: "max_completion_tokens",
        supportsDeveloperRole: true,
      }
      assert.equal(
        compatForEndpoint(model, wire, host, () => {
          return assert.fail("same-wire user settings must survive")
        }),
        host,
      )
    }
  })
  it("discards stale or inherited wire tags even when the catalog itself changes wire", () => {
    const current = { ...model, api: "openai-completions" as const }
    const authoritative = { replayReasoningContent: true, maxTokensField: "max_tokens" }
    const stale = { commandCodeWire: "openai-responses", sessionAffinityFormat: "openai-nosession" }
    assert.equal(
      compatForEndpoint<Record<string, unknown>>(current, current.api, stale, () => authoritative),
      authoritative,
    )
    const inherited = Object.assign(Object.create({ commandCodeWire: "openai-completions" }), stale)
    delete inherited.commandCodeWire
    assert.equal(
      compatForEndpoint(current, current.api, inherited, () => authoritative),
      authoritative,
    )
  })
  it("replaces stale wire flags, retaining authoritative reasoning flags and unknown-model fallback", () => {
    const stale = { sessionAffinityFormat: "openai-nosession", supportsLongCacheRetention: false }
    const authoritative = { replayReasoningContent: true, maxTokensField: "max_tokens" }
    let seen: CommandCodeModel | undefined
    const actual = compatForEndpoint<Record<string, unknown>>(
      model,
      "openai-completions",
      stale,
      (resolved) => {
        seen = resolved
        return authoritative
      },
    )
    assert.equal(actual, authoritative)
    assert.deepEqual(seen, { ...model, api: "openai-completions" })
    assert.equal(Object.hasOwn(actual, "sessionAffinityFormat"), false)
    assert.equal(Object.hasOwn(actual, "supportsLongCacheRetention"), false)
    assert.equal(model.api, "openai-responses")
    assert.equal(
      compatForEndpoint(undefined, "openai-completions", stale, () => {
        throw new Error("must not call")
      }),
      stale,
    )
  })
})
