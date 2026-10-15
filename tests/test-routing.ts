import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import {
  loadEndpointOverrides,
  parseEndpointOverrides,
  resolveEndpoint,
  saveEndpointChoice,
} from "../src/routing.ts"
import type { CommandCodeModel } from "../src/models.ts"

const model: CommandCodeModel = {
  id: "zai-org/GLM-5.3",
  name: "GLM",
  api: "openai-responses",
  reasoning: true,
  contextWindow: 1000000,
  maxTokens: 65536,
}

describe("persistent endpoint choices", () => {
  it("uses catalog auto and per-model overrides without changing other models", () => {
    assert.equal(resolveEndpoint(model, {}), "openai-responses")
    assert.equal(resolveEndpoint(model, { [model.id]: "chat-completions" }), "openai-completions")
    assert.equal(
      resolveEndpoint({ ...model, id: "meta/muse-spark-1.3" }, { [model.id]: "chat-completions" }),
      "openai-responses",
    )
    assert.equal(resolveEndpoint({ ...model, api: "openai-completions" }, {}), "openai-completions")
    assert.throws(
      () => resolveEndpoint({ ...model, api: "openai-completions" }, { [model.id]: "responses" }),
      /does not advertise/,
    )
    assert.throws(
      () =>
        resolveEndpoint(
          { ...model, api: "anthropic-messages" },
          { [model.id]: "chat-completions" },
        ),
      /Claude/,
    )
  })
  it("survives restart and catalog replacement; auto removes just one override", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-routing-"))
    const path = join(dir, "commandcode-routing.json")
    try {
      assert.deepEqual(await loadEndpointOverrides(path), {})
      await saveEndpointChoice(path, "other", "responses")
      await saveEndpointChoice(path, model.id, "chat-completions")
      assert.equal(
        resolveEndpoint({ ...model }, await loadEndpointOverrides(path)),
        "openai-completions",
      )
      await saveEndpointChoice(path, model.id, "auto")
      assert.deepEqual(await loadEndpointOverrides(path), { other: "responses" })
      assert.match(await readFile(path, "utf8"), /"version": 1/)
      await writeFile(path, '{"secret":"sensitive", broken')
      await assert.rejects(
        loadEndpointOverrides(path),
        (error: unknown) => error instanceof Error && !error.message.includes("sensitive"),
      )
      await assert.rejects(saveEndpointChoice(path, model.id, "auto"))
      assert.match(await readFile(path, "utf8"), /sensitive/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it("validates file shapes without exposing arbitrary values", () => {
    for (const value of [
      null,
      [],
      { version: 2, models: {} },
      { version: 1, models: { foo: "secret" } },
    ]) {
      assert.throws(() => parseEndpointOverrides(value))
    }
    assert.deepEqual(parseEndpointOverrides({ version: 1, models: { foo: "auto" } }), {
      foo: "auto",
    })
  })
})
