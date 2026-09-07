import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { MODEL_EFFORT_OVERRIDES } from "../src/commandcode-catalog-overrides.ts"
import {
  COMMAND_CODE_CLI_VERSION,
  MODEL_EFFORTS as CATALOG_MODEL_EFFORTS,
} from "../src/commandcode-catalog.ts"
import {
  apiForModelId,
  baseUrlForModel,
  commandCodeModelsFromApiResponse,
  commandCodeModelsFromCache,
  DEFAULT_MODELS_TIMEOUT_MS,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCommandCodeModels,
  MODEL_EFFORTS,
  MODEL_INPUT_MODALITIES,
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_REASONING,
  modelSupportsImageInput,
  thinkingLevelMapForEfforts,
  thinkingMetadataForModel,
  type CommandCodeModel,
} from "../src/models.ts"

const API_RESPONSE = {
  object: "list",
  data: [
    {
      id: "Qwen/Qwen3.7-Max",
      object: "model",
      created: 1779824324,
      owned_by: "command-code",
      name: "Qwen 3.7 Max",
      context_length: 1_000_000,
    },
  ],
}

const EXPECTED_MODELS: readonly CommandCodeModel[] = [
  {
    id: "Qwen/Qwen3.7-Max",
    name: "Qwen 3.7 Max (CC)",
    api: "openai-completions",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
]

function successfulFetch(): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(API_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
}

function failingFetch(message = "offline"): typeof fetch {
  return () => Promise.reject(new TypeError(message))
}

function hangingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      )
    })
}

async function withTemporaryCache(
  run: (paths: { directory: string; cachePath: string }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-commandcode-models-"))
  try {
    await run({ directory, cachePath: join(directory, "models.json") })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("commandCodeModelsFromApiResponse()", () => {
  it("converts the Provider API model list to pi models", () => {
    assert.deepEqual(commandCodeModelsFromApiResponse(API_RESPONSE), EXPECTED_MODELS)
  })

  it("routes Claude models to Anthropic Messages and all others to Chat Completions", () => {
    assert.equal(apiForModelId("claude-sonnet-4-6"), "anthropic-messages")
    assert.equal(apiForModelId("gpt-5.6-sol"), "openai-completions")
    assert.equal(
      baseUrlForModel("https://api.commandcode.ai/provider/v1/", "openai-completions"),
      "https://api.commandcode.ai/provider/v1",
    )
    assert.equal(
      baseUrlForModel("https://api.commandcode.ai/provider/v1/", "anthropic-messages"),
      "https://api.commandcode.ai/provider",
    )
  })

  it(`uses the command-code@${COMMAND_CODE_CLI_VERSION} image capability catalog`, () => {
    const imageModels = Object.keys(MODEL_INPUT_MODALITIES)
    assert.ok(imageModels.length > 0)
    for (const modelId of imageModels) {
      assert.deepEqual(MODEL_INPUT_MODALITIES[modelId], ["text", "image"], modelId)
      assert.deepEqual(inputModalitiesForModel(modelId), ["text", "image"], modelId)
      assert.equal(modelSupportsImageInput(modelId), true, modelId)
    }

    const textOnlyModel = Object.keys(MODEL_REASONING).find(
      (modelId) => !(modelId in MODEL_INPUT_MODALITIES),
    )
    assert.ok(textOnlyModel, "catalog should contain at least one text-only model")
    assert.deepEqual(inputModalitiesForModel(textOnlyModel), ["text"])
    assert.equal(modelSupportsImageInput(textOnlyModel), false)
    assert.deepEqual(inputModalitiesForModel("unknown-new-model"), ["text"])
    assert.equal(modelSupportsImageInput("unknown-new-model"), false)
  })

  it("includes newly published image and reasoning capabilities", () => {
    for (const modelId of ["gpt-6-astra", "xai/grok-4.6"]) {
      assert.deepEqual(inputModalitiesForModel(modelId), ["text", "image"])
    }
    assert.equal(MODEL_REASONING["gpt-6-astra"], true)
    assert.deepEqual(MODEL_EFFORTS["gpt-6-astra"], ["low", "medium", "high", "xhigh", "max"])
    for (const modelId of [
      "meta/muse-spark-1.1",
      "meta/muse-spark-1.2",
      "meta/muse-spark-1.2-contributor",
      "meta/muse-spark-1.3-contributor",
    ]) {
      assert.deepEqual(MODEL_EFFORTS[modelId], ["low", "medium", "high", "xhigh"])
    }
    assert.deepEqual(MODEL_EFFORTS["meta/muse-spark-1.3"], [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })

  it("tracks reasoning independently from selectable effort levels", () => {
    const reasoningModels = Object.keys(MODEL_REASONING)
    const effortModels = Object.keys(MODEL_EFFORTS)
    assert.ok(reasoningModels.length > 0)
    assert.ok(effortModels.length > 0)
    for (const modelId of effortModels) {
      assert.equal(MODEL_REASONING[modelId], true, `${modelId} has efforts but no reasoning flag`)
    }

    const reasoningWithoutEfforts = reasoningModels.find((modelId) => !(modelId in MODEL_EFFORTS))
    assert.ok(reasoningWithoutEfforts, "catalog should contain a reasoning model without efforts")

    const models = commandCodeModelsFromApiResponse({
      object: "list",
      data: [
        { ...API_RESPONSE.data[0], id: effortModels[0] },
        { ...API_RESPONSE.data[0], id: reasoningWithoutEfforts },
        { ...API_RESPONSE.data[0], id: "new-model-without-metadata" },
      ],
    })

    assert.equal(models[0]?.reasoning, true)
    assert.equal(models[1]?.reasoning, true)
    assert.deepEqual(thinkingMetadataForModel(reasoningWithoutEfforts), {
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
    })
    assert.equal(models[2]?.reasoning, false)
  })

  it("uses model-specific output limits from the CLI catalog", () => {
    const limitedModels = Object.entries(MODEL_MAX_OUTPUT_TOKENS)
    assert.ok(limitedModels.length > 0)
    for (const [modelId, limit] of limitedModels) {
      assert.ok(Number.isInteger(limit) && limit > 0, `${modelId} has an invalid output limit`)
    }

    const [limitedId, limit] = limitedModels[0]!
    const models = commandCodeModelsFromApiResponse({
      object: "list",
      data: [
        { ...API_RESPONSE.data[0], id: limitedId, context_length: limit * 4 },
        { ...API_RESPONSE.data[0], id: limitedId, context_length: Math.floor(limit / 2) },
        { ...API_RESPONSE.data[0], id: "unknown-new-model", context_length: 256_000 },
        { ...API_RESPONSE.data[0], id: "unknown-new-model", context_length: 8_192 },
      ],
    })

    assert.deepEqual(
      models.map(({ maxTokens }) => maxTokens),
      [limit, Math.floor(limit / 2), 65_536, 8_192],
    )
  })

  it(`uses the command-code@${COMMAND_CODE_CLI_VERSION} reasoning effort catalog`, () => {
    const validEfforts = new Set(["minimal", "low", "medium", "high", "xhigh", "max"])
    assert.ok(Object.keys(MODEL_EFFORTS).length > 0)
    for (const efforts of Object.values(MODEL_EFFORTS)) {
      assert.ok(efforts.length > 0)
      assert.equal(new Set(efforts).size, efforts.length)
      assert.ok(efforts.every((effort) => validEfforts.has(effort)))
    }
  })

  it("merges manual effort overrides over the generated catalog", () => {
    const validEfforts = new Set(["minimal", "low", "medium", "high", "xhigh", "max"])
    for (const [modelId, efforts] of Object.entries(MODEL_EFFORT_OVERRIDES)) {
      assert.equal(MODEL_REASONING[modelId], true, `${modelId} override needs a reasoning flag`)
      assert.equal(
        CATALOG_MODEL_EFFORTS[modelId],
        undefined,
        `${modelId} now has upstream efforts; drop the manual override`,
      )
      assert.ok(efforts.length > 0)
      assert.ok(efforts.every((effort) => validEfforts.has(effort)))
      assert.deepEqual(MODEL_EFFORTS[modelId], efforts)
      assert.deepEqual(thinkingMetadataForModel(modelId)?.thinking?.efforts, efforts)
    }
    for (const [modelId, efforts] of Object.entries(CATALOG_MODEL_EFFORTS)) {
      assert.deepEqual(MODEL_EFFORTS[modelId], efforts, `${modelId} upstream efforts changed`)
    }
  })

  it("builds separate canonical pi and OMP metadata", () => {
    for (const [modelId, efforts] of Object.entries(MODEL_EFFORTS)) {
      const metadata = thinkingMetadataForModel(modelId)
      assert.ok(metadata, `${modelId} should have reasoning metadata`)
      assert.ok(metadata.thinking)
      assert.equal(metadata.thinking.mode, "effort")
      assert.deepEqual(metadata.thinking.efforts, efforts)
      assert.deepEqual(
        metadata.thinking.effortMap,
        Object.fromEntries(efforts.map((effort) => [effort, effort])),
      )
      assert.equal("defaultLevel" in metadata.thinking, false)
      for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        const expected = efforts.includes(level)
        assert.equal(
          metadata.thinkingLevelMap[level],
          expected ? level : null,
          `${modelId} should map ${level} according to its catalog entry`,
        )
      }
    }

    assert.deepEqual(thinkingLevelMapForEfforts(MODEL_EFFORTS["deepseek/deepseek-v4-flash"]), {
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    })
    assert.deepEqual(thinkingMetadataForModel("new-model-without-metadata"), undefined)
  })

  it("rejects unexpected API shapes", () => {
    assert.throws(() => commandCodeModelsFromApiResponse({ object: "list", data: [{}] }))
  })
})

describe("commandCodeModelsFromCache()", () => {
  it("accepts the current cache format", () => {
    assert.deepEqual(
      commandCodeModelsFromCache({ version: 1, models: EXPECTED_MODELS }),
      EXPECTED_MODELS,
    )
  })

  it("normalizes cached reasoning metadata from the model id", () => {
    const cached = commandCodeModelsFromCache({
      version: 1,
      models: [
        {
          ...EXPECTED_MODELS[0],
          id: "deepseek/deepseek-v4-flash",
          reasoning: false,
        },
      ],
    })
    assert.equal(cached[0]?.reasoning, true)
  })

  it("rejects empty, invalid, and unsupported caches", () => {
    assert.throws(() => commandCodeModelsFromCache({ version: 1, models: [] }))
    assert.throws(() => commandCodeModelsFromCache({ version: 2, models: EXPECTED_MODELS }))
    assert.throws(() =>
      commandCodeModelsFromCache({
        version: 1,
        models: [{ ...EXPECTED_MODELS[0], contextWindow: -1 }],
      }),
    )
  })
})

describe("model discovery configuration", () => {
  it("uses a safe default timeout and ignores invalid environment values", () => {
    assert.equal(getModelsTimeoutMs({}), DEFAULT_MODELS_TIMEOUT_MS)
    assert.equal(
      getModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "0" }),
      DEFAULT_MODELS_TIMEOUT_MS,
    )
    assert.equal(
      getModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "invalid" }),
      DEFAULT_MODELS_TIMEOUT_MS,
    )
    assert.equal(getModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "25" }), 25)
  })
})

describe("loadCommandCodeModels()", () => {
  it("falls back to cache when live discovery times out", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await loadCommandCodeModels({ cachePath, fetchImpl: successfulFetch() })

      const startedAt = Date.now()
      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: hangingFetch(),
        timeoutMs: 25,
      })

      assert.ok(Date.now() - startedAt < 500)
      assert.deepEqual(result.models, EXPECTED_MODELS)
      assert.equal(result.source, "cache")
      assert.match(result.warning ?? "", /timed out after 25ms/)
      assert.match(result.warning ?? "", /Using the cached catalog/)
    })
  })

  it("preserves an external abort instead of falling back to cache", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await loadCommandCodeModels({ cachePath, fetchImpl: successfulFetch() })
      const controller = new AbortController()
      const promise = loadCommandCodeModels({
        cachePath,
        fetchImpl: hangingFetch(),
        timeoutMs: 1_000,
        signal: controller.signal,
      })

      controller.abort(new Error("caller cancelled discovery"))

      await assert.rejects(promise, /caller cancelled discovery/)
    })
  })

  it("returns live models and writes a validated cache", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: successfulFetch(),
      })

      assert.deepEqual(result, { models: EXPECTED_MODELS, source: "live" })
      assert.deepEqual(
        commandCodeModelsFromCache(JSON.parse(await readFile(cachePath, "utf-8"))),
        EXPECTED_MODELS,
      )
    })
  })

  it("uses the last valid catalog when the refresh fails", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await loadCommandCodeModels({ cachePath, fetchImpl: successfulFetch() })

      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.deepEqual(result.models, EXPECTED_MODELS)
      assert.equal(result.source, "cache")
      assert.match(result.warning ?? "", /offline/)
      assert.match(result.warning ?? "", /Using the cached catalog/)
    })
  })

  it("starts with an empty catalog when offline without a valid cache", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.deepEqual(result.models, [])
      assert.equal(result.source, "empty")
      assert.match(result.warning ?? "", /no valid cached catalog/)
      assert.match(result.warning ?? "", /until \/commandcode-refresh succeeds/)
    })
  })

  it("recovers live models after an empty offline start", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const empty = await loadCommandCodeModels({
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.equal(empty.source, "empty")
      assert.deepEqual(empty.models, [])

      const recovered = await loadCommandCodeModels({
        cachePath,
        fetchImpl: successfulFetch(),
      })

      assert.deepEqual(recovered, { models: EXPECTED_MODELS, source: "live" })
      assert.deepEqual(
        commandCodeModelsFromCache(JSON.parse(await readFile(cachePath, "utf-8"))),
        EXPECTED_MODELS,
      )
    })
  })

  it("ignores a corrupt cache after a failed refresh", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await writeFile(cachePath, "not json", "utf-8")

      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.deepEqual(result.models, [])
      assert.equal(result.source, "empty")
      assert.match(result.warning ?? "", /Unexpected token|JSON/)
    })
  })

  it("keeps live models usable when the cache cannot be written", async () => {
    await withTemporaryCache(async ({ directory }) => {
      const unwritableCachePath = join(directory, "cache-directory")
      await mkdir(unwritableCachePath)

      const result = await loadCommandCodeModels({
        cachePath: unwritableCachePath,
        fetchImpl: successfulFetch(),
      })

      assert.deepEqual(result.models, EXPECTED_MODELS)
      assert.equal(result.source, "live")
      assert.match(result.warning ?? "", /could not update/)
    })
  })

  it("falls back to cache for HTTP and response parsing failures", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await loadCommandCodeModels({ cachePath, fetchImpl: successfulFetch() })

      for (const fetchImpl of [
        (() => Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch,
        (() =>
          Promise.resolve(
            new Response("not json", {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          )) as typeof fetch,
      ]) {
        const result = await loadCommandCodeModels({ cachePath, fetchImpl })
        assert.deepEqual(result.models, EXPECTED_MODELS)
        assert.equal(result.source, "cache")
      }
    })
  })
})
