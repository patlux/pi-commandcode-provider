import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  commandCodeModelsFromApiResponse,
  commandCodeModelsFromCache,
  DEFAULT_MODELS_TIMEOUT_MS,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCommandCodeModels,
  MODEL_EFFORTS,
  MODEL_INPUT_MODALITIES,
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
    reasoning: false,
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

  it("matches command-code@1.15.1 image input capabilities", () => {
    assert.deepEqual(inputModalitiesForModel("gpt-5.6-luna"), ["text", "image"])
    assert.deepEqual(inputModalitiesForModel("meta/muse-spark-1.2"), ["text", "image"])
    assert.deepEqual(inputModalitiesForModel("deepseek/deepseek-v4-pro"), ["text"])
    assert.deepEqual(inputModalitiesForModel("unknown-new-model"), ["text"])
    assert.equal(modelSupportsImageInput("gpt-5.6-luna"), true)
    assert.equal(modelSupportsImageInput("deepseek/deepseek-v4-pro"), false)
    assert.equal(Object.keys(MODEL_INPUT_MODALITIES).length, 37)
  })

  it("marks only known reasoning models as reasoning-capable", () => {
    const models = commandCodeModelsFromApiResponse({
      object: "list",
      data: [
        { ...API_RESPONSE.data[0], id: "deepseek/deepseek-v4-flash" },
        { ...API_RESPONSE.data[0], id: "new-model-without-metadata" },
      ],
    })

    assert.equal(models[0]?.reasoning, true)
    assert.equal(models[1]?.reasoning, false)
  })

  it("matches the exact command-code@1.15.1 reasoning effort catalog", () => {
    assert.deepEqual(MODEL_EFFORTS, {
      "Qwen/Qwen3.8-Max": ["low", "medium", "xhigh"],
      "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
      "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
      "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
      "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
      "claude-sonnet-4-6": ["low", "medium", "high", "xhigh", "max"],
      "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
      "deepseek/deepseek-v4-flash": ["high", "max"],
      "deepseek/deepseek-v4-pro": ["high", "max"],
      "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
      "gpt-5.4": ["low", "medium", "high", "xhigh"],
      "gpt-5.4-mini": ["low", "medium", "high"],
      "gpt-5.5": ["low", "medium", "high", "xhigh"],
      "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
      "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
      "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
      "google/gemini-3.1-flash-lite": ["low", "medium", "high"],
      "google/gemini-3.5-flash": ["low", "medium", "high"],
      "google/gemini-3.5-flash-lite": ["low", "medium", "high"],
      "google/gemini-3.6-flash": ["low", "medium", "high"],
      "sakana/fugu-ultra": ["high", "xhigh"],
      "xai/grok-4.5": ["low", "medium", "high"],
      "zai-org/GLM-5.2": ["high", "max"],
    })
  })

  it("builds separate canonical pi and OMP metadata", () => {
    for (const [modelId, efforts] of Object.entries(MODEL_EFFORTS)) {
      const metadata = thinkingMetadataForModel(modelId)
      assert.ok(metadata, `${modelId} should have reasoning metadata`)
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
