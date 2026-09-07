import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"

import {
  MODEL_COSTS,
  PRICING_LAST_VERIFIED,
  PRICING_SOURCE_URL,
  TEMPORARY_PRICING,
} from "../src/pricing.ts"

interface ModelCatalogSnapshot {
  fetchedAt: string
  source: string
  modelIds: string[]
}

interface PricingSnapshot {
  verifiedAt: string
  source: string
  tierPolicy: string
  tiers: Record<string, [number, number, number, number, number][]>
  costs: Record<string, [number, number, number, number]>
}

const fixtureUrl = new URL("./fixtures/commandcode-model-ids.json", import.meta.url)
const fixture = JSON.parse(await readFile(fixtureUrl, "utf-8")) as ModelCatalogSnapshot
const pricingFixtureUrl = new URL("./fixtures/commandcode-pricing.json", import.meta.url)
const pricingFixture = JSON.parse(await readFile(pricingFixtureUrl, "utf-8")) as PricingSnapshot
const freeModels = new Set(["poolside/laguna-s-2.1-free", "meituan/LongCat-2.0:free"])

function assertCost(
  modelId: string,
  expected: { input: number; output: number; cacheRead: number; cacheWrite: number },
) {
  const cost = MODEL_COSTS[modelId]
  assert.ok(cost, `${modelId} should have pricing`)
  assert.deepEqual(
    {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cacheRead,
      cacheWrite: cost.cacheWrite,
    },
    expected,
    `${modelId} base pricing should match the source`,
  )
}

describe("MODEL_COSTS pricing overlay", () => {
  it("covers the current Command Code model catalog snapshot", () => {
    assert.equal(fixture.source, "https://api.commandcode.ai/provider/v1/models")
    assert.match(fixture.fetchedAt, /^2026-09-/)

    const catalogIds = [...fixture.modelIds].sort()
    const pricedIds = Object.keys(MODEL_COSTS).sort()
    assert.deepEqual(pricedIds, catalogIds)
  })

  it("matches the verified official pricing snapshot", () => {
    assert.equal(pricingFixture.verifiedAt, PRICING_LAST_VERIFIED)
    assert.equal(pricingFixture.source, PRICING_SOURCE_URL)
    assert.match(pricingFixture.tierPolicy, /request-wide input tiers/)

    const expected = Object.fromEntries(
      Object.entries(pricingFixture.costs).map(
        ([modelId, [input, output, cacheRead, cacheWrite]]) => [
          modelId,
          {
            input,
            output,
            cacheRead,
            cacheWrite,
            ...(pricingFixture.tiers[modelId]
              ? {
                  tiers: pricingFixture.tiers[modelId].map(
                    ([inputTokensAbove, tierInput, tierOutput, tierCacheRead, tierCacheWrite]) => ({
                      inputTokensAbove,
                      input: tierInput,
                      output: tierOutput,
                      cacheRead: tierCacheRead,
                      cacheWrite: tierCacheWrite,
                    }),
                  ),
                }
              : {}),
          },
        ],
      ),
    )
    assert.deepEqual(MODEL_COSTS, expected)
  })

  it("uses non-zero prices except for models documented as free", () => {
    for (const [modelId, cost] of Object.entries(MODEL_COSTS)) {
      assert.ok(cost.input >= 0, `${modelId} input cost should be non-negative`)
      assert.ok(cost.output >= 0, `${modelId} output cost should be non-negative`)
      assert.ok(cost.cacheRead >= 0, `${modelId} cache-read cost should be non-negative`)
      assert.ok(cost.cacheWrite >= 0, `${modelId} cache-write cost should be non-negative`)

      const allZero = Object.values(cost).every((value) => value === 0)
      assert.equal(
        allZero,
        freeModels.has(modelId),
        `${modelId} free-model status should be explicit`,
      )
    }
  })

  it("matches corrected official rates", () => {
    assertCost("deepseek/deepseek-v4-pro", {
      input: 0.66,
      output: 1.98,
      cacheRead: 0.022,
      cacheWrite: 0,
    })
    assertCost("deepseek/deepseek-v4-flash", {
      input: 0.22,
      output: 0.66,
      cacheRead: 0.007,
      cacheWrite: 0,
    })
    assertCost("Qwen/Qwen3.7-Max", {
      input: 2.5,
      output: 7.5,
      cacheRead: 0.5,
      cacheWrite: 3.13,
    })
    assertCost("xiaomi/mimo-v2.5-pro", {
      input: 0.435,
      output: 0.87,
      cacheRead: 0.0036,
      cacheWrite: 0,
    })
    assertCost("MiniMaxAI/MiniMax-M2.5", {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.03,
      cacheWrite: 0,
    })
    assertCost("Qwen/Qwen3.8-27B", {
      input: 0.4,
      output: 3,
      cacheRead: 0.04,
      cacheWrite: 0,
    })
    assertCost("Qwen/Qwen3.8-Flash", {
      input: 0.16,
      output: 0.47,
      cacheRead: 0.016,
      cacheWrite: 0,
    })
    assertCost("z-ai/glm-5.3-flash", {
      input: 0.15,
      output: 0.5,
      cacheRead: 0.03,
      cacheWrite: 0,
    })
    assertCost("tencent/hy4-preview", {
      input: 0.834,
      output: 2.501,
      cacheRead: 0.042,
      cacheWrite: 0,
    })
    assertCost("google/gemini-3.7-flash", {
      input: 1.5,
      output: 7.5,
      cacheRead: 0.15,
      cacheWrite: 0.08334,
    })
    assertCost("claude-fable-5-1", {
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite: 12.5,
    })
    assertCost("deepseek/deepseek-v4-flash-fast", {
      input: 0.28,
      output: 0.56,
      cacheRead: 0.07,
      cacheWrite: 0,
    })
    assertCost("meta/muse-spark-1.2-contributor", {
      input: 0.1,
      output: 0.2,
      cacheRead: 0.002,
      cacheWrite: 0,
    })
    assertCost("meta/muse-spark-1.3", {
      input: 1.25,
      output: 4.25,
      cacheRead: 0.15,
      cacheWrite: 0,
    })
    assertCost("meta/muse-spark-1.3-contributor", {
      input: 0.1,
      output: 0.2,
      cacheRead: 0.002,
      cacheWrite: 0,
    })
    assertCost("gpt-6-astra", {
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
    })
  })

  it("uses the documented base rates for context-dependent models", () => {
    assertCost("Qwen/Qwen3.7-Plus", {
      input: 0.4,
      output: 1.6,
      cacheRead: 0.08,
      cacheWrite: 0.5,
    })
    assertCost("Qwen/Qwen3.7-Flash", {
      input: 0.03,
      output: 0.13,
      cacheRead: 0.006,
      cacheWrite: 0.038,
    })
    assertCost("gpt-5.6-terra", {
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    })
    assertCost("gpt-5.6-luna", {
      input: 0.2,
      output: 1.2,
      cacheRead: 0.02,
      cacheWrite: 0.25,
    })
    assert.deepEqual(MODEL_COSTS["xai/grok-4.6"]?.tiers, [
      {
        inputTokensAbove: 200_000,
        input: 4,
        output: 12,
        cacheRead: 1,
        cacheWrite: 0,
      },
    ])
  })

  it("tracks pricing provenance", () => {
    assert.equal(PRICING_SOURCE_URL, "https://commandcode.ai/docs/resources/pricing-limits")
    assert.equal(PRICING_LAST_VERIFIED, "2026-09-06")
  })

  it("fails once temporary pricing needs review", () => {
    const today = new Date().toISOString().slice(0, 10)
    for (const pricing of TEMPORARY_PRICING) {
      assert.match(pricing.expiresOn, /^\d{4}-\d{2}-\d{2}$/)
      assert.ok(pricing.models.length > 0)
      assert.ok(
        pricing.expiresOn >= today,
        `${pricing.description} for ${pricing.models.join(", ")} expired on ${pricing.expiresOn}; refresh MODEL_COSTS`,
      )
      for (const modelId of pricing.models) {
        assert.ok(MODEL_COSTS[modelId], `${modelId} should have a temporary price entry`)
      }
    }
  })
})
