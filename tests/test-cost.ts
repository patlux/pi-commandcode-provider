/**
 * Regression test for the local cost calculation.
 *
 * The provider ships its own cost function because Oh My Pi's legacy pi-ai
 * shim does not export `calculateCost` (see issue #24). This test locks the
 * local implementation to pi-ai's documented per-million-token arithmetic
 * without installing another pi-ai runtime next to the extension.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { calculateCommandCodeCost, commandCodeCostRatesAt, isDeepSeekV4Peak } from "../src/cost.ts"
import type { Usage } from "../src/types.ts"

interface CostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface CostTable extends CostRates {
  tiers?: Array<CostRates & { inputTokensAbove: number }>
}

const COST_FIXTURES: Record<string, CostTable> = {
  "zero-cost-model": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "deepseek/deepseek-v4-pro": {
    input: 0.435,
    output: 0.87,
    cacheRead: 0.003625,
    cacheWrite: 0,
  },
  "Qwen/Qwen3.7-Max": { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.13 },
  "Qwen/Qwen3.7-Flash": {
    input: 0.03,
    output: 0.13,
    cacheRead: 0.006,
    cacheWrite: 0.038,
    tiers: [
      { inputTokensAbove: 32_000, input: 0.1, output: 0.4, cacheRead: 0.02, cacheWrite: 0.125 },
      { inputTokensAbove: 256_000, input: 0.2, output: 0.8, cacheRead: 0.04, cacheWrite: 0.25 },
    ],
  },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
}

const USAGE_CASES = [
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  { input: 812, output: 187, cacheRead: 52_000, cacheWrite: 3_100 },
  { input: 1_000_000, output: 65_536, cacheRead: 998_877, cacheWrite: 123_456 },
  { input: 7, output: 999_999_999, cacheRead: 0.5, cacheWrite: 42 },
]

const OFF_PEAK_WEEKDAY = Date.parse("2026-09-28T05:00:00Z")
const PEAK_WEEKDAY = Date.parse("2026-09-28T06:00:00Z")

function commandCodeModel(id: string, cost: CostTable) {
  return {
    id,
    api: "commandcode-custom",
    provider: "commandcode",
    cost,
    maxTokens: 65_536,
  }
}

function assertClose(actual: number, expected: number) {
  assert.ok(
    Math.abs(actual - expected) <=
      Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected)),
    `expected ${actual} to be close to ${expected}`,
  )
}

function freshUsage(tokens: (typeof USAGE_CASES)[number]): Usage {
  return {
    ...tokens,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function expectedCost(cost: CostTable, tokens: (typeof USAGE_CASES)[number]): Usage["cost"] {
  const inputTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite
  let rates: CostRates = cost
  let matchedThreshold = -1
  for (const tier of cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier
      matchedThreshold = tier.inputTokensAbove
    }
  }

  const input = (rates.input / 1_000_000) * tokens.input
  const output = (rates.output / 1_000_000) * tokens.output
  const cacheRead = (rates.cacheRead / 1_000_000) * tokens.cacheRead
  const cacheWrite = (rates.cacheWrite * tokens.cacheWrite) / 1_000_000
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  }
}

describe("calculateCommandCodeCost()", () => {
  it("applies per-million-token rates to all cost fields", () => {
    for (const [id, cost] of Object.entries(COST_FIXTURES)) {
      const model = commandCodeModel(id, cost)

      for (const tokens of USAGE_CASES) {
        const usage = freshUsage(tokens)
        calculateCommandCodeCost(model, usage, OFF_PEAK_WEEKDAY)

        assert.deepEqual(
          usage.cost,
          expectedCost(cost, tokens),
          `${id} cost for tokens=${JSON.stringify(tokens)}`,
        )
      }
    }
  })

  it("uses weekday UTC peak windows with exact boundary behavior", () => {
    const cases: Array<[string, boolean]> = [
      ["2026-09-28T00:59:59.999Z", false],
      ["2026-09-28T01:00:00.000Z", true],
      ["2026-09-28T03:59:59.999Z", true],
      ["2026-09-28T04:00:00.000Z", false],
      ["2026-09-28T05:59:59.999Z", false],
      ["2026-09-28T06:00:00.000Z", true],
      ["2026-09-28T09:59:59.999Z", true],
      ["2026-09-28T10:00:00.000Z", false],
    ]

    for (const [timestamp, expected] of cases) {
      assert.equal(isDeepSeekV4Peak(Date.parse(timestamp)), expected, timestamp)
    }
  })

  it("keeps weekends entirely off-peak", () => {
    assert.equal(isDeepSeekV4Peak(Date.parse("2026-10-03T02:00:00Z")), false)
    assert.equal(isDeepSeekV4Peak(Date.parse("2026-10-04T07:00:00Z")), false)
  })

  it("selects the same request-time rates for native provider transports", () => {
    const base = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 }
    assert.deepEqual(commandCodeCostRatesAt("deepseek/deepseek-v4-flash", base, PEAK_WEEKDAY), {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.006,
      cacheWrite: 0,
    })
    assert.equal(commandCodeCostRatesAt("deepseek/deepseek-v4-flash", base, OFF_PEAK_WEEKDAY), base)
  })

  it("doubles DeepSeek V4 rates during peak windows", () => {
    const model = commandCodeModel("deepseek/deepseek-v4-pro", {
      input: 0.66,
      output: 1.98,
      cacheRead: 0.022,
      cacheWrite: 0,
    })
    const usage = freshUsage({
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 0,
    })

    calculateCommandCodeCost(model, usage, PEAK_WEEKDAY)

    assertClose(usage.cost.input, 1.32)
    assertClose(usage.cost.output, 3.96)
    assertClose(usage.cost.cacheRead, 0.044)
    assert.equal(usage.cost.cacheWrite, 0)
    assertClose(usage.cost.total, 1.32 + 3.96 + 0.044)
  })

  it("applies peak pricing to every time-priced DeepSeek V4 model but not V4 Flash Fast", () => {
    const timePriced = [
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-vision-exp",
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash-fast",
    ]

    for (const modelId of timePriced) {
      const model = commandCodeModel(modelId, {
        input: 1,
        output: 2,
        cacheRead: 0.5,
        cacheWrite: 0,
      })
      const usage = freshUsage({
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 0,
      })
      calculateCommandCodeCost(model, usage, PEAK_WEEKDAY)
      assert.equal(usage.cost.input, 2, modelId)
      assert.equal(usage.cost.output, 4, modelId)
      assert.equal(usage.cost.cacheRead, 1, modelId)
    }

    const fastModel = commandCodeModel("deepseek/deepseek-v4-flash-fast", {
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 0,
    })
    const fastUsage = freshUsage({
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 0,
    })
    calculateCommandCodeCost(fastModel, fastUsage, PEAK_WEEKDAY)
    assert.equal(fastUsage.cost.input, 1)
    assert.equal(fastUsage.cost.output, 2)
    assert.equal(fastUsage.cost.cacheRead, 0.5)
  })

  it("applies the highest request-wide input tier above its threshold", () => {
    const model = commandCodeModel("Qwen/Qwen3.7-Flash", COST_FIXTURES["Qwen/Qwen3.7-Flash"])

    const atThreshold = freshUsage({
      input: 32_000,
      output: 1_000,
      cacheRead: 0,
      cacheWrite: 0,
    })
    calculateCommandCodeCost(model, atThreshold)
    assertClose(atThreshold.cost.input, (0.03 * 32_000) / 1_000_000)

    const aboveFirstTier = freshUsage({
      input: 30_000,
      output: 1_000,
      cacheRead: 2_001,
      cacheWrite: 0,
    })
    calculateCommandCodeCost(model, aboveFirstTier)
    assertClose(aboveFirstTier.cost.input, (0.1 * 30_000) / 1_000_000)
    assertClose(aboveFirstTier.cost.cacheRead, (0.02 * 2_001) / 1_000_000)

    const aboveHighestTier = freshUsage({
      input: 100_000,
      output: 1_000,
      cacheRead: 156_001,
      cacheWrite: 0,
    })
    calculateCommandCodeCost(model, aboveHighestTier)
    assertClose(aboveHighestTier.cost.input, (0.2 * 100_000) / 1_000_000)
    assertClose(aboveHighestTier.cost.output, (0.8 * 1_000) / 1_000_000)
  })

  it("prices one-hour cache writes at twice the active input rate", () => {
    const model = commandCodeModel("claude-sonnet-4-6", COST_FIXTURES["claude-sonnet-4-6"])
    const usage = freshUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000 })
    usage.cacheWrite1h = 400

    calculateCommandCodeCost(model, usage)

    const expectedShortWrite = (3.75 * 600) / 1_000_000
    const expectedLongWrite = (3 * 2 * 400) / 1_000_000
    assertClose(usage.cost.cacheWrite, expectedShortWrite + expectedLongWrite)
  })

  it("writes the total as the sum of all cost components", () => {
    const model = commandCodeModel("claude-sonnet-4-6", COST_FIXTURES["claude-sonnet-4-6"])
    const usage = freshUsage({ input: 1_000, output: 500, cacheRead: 10_000, cacheWrite: 2_000 })

    calculateCommandCodeCost(model, usage)

    assert.equal(
      usage.cost.total,
      usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite,
    )
    assert.ok(usage.cost.total > 0)
  })
})
