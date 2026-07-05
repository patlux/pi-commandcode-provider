/**
 * Regression test for the local cost calculation.
 *
 * The provider ships its own cost function because Oh My Pi's legacy pi-ai
 * shim does not export `calculateCost` (see issue #24). This test locks the
 * local implementation to pi-ai's upstream `calculateCost` so the two cannot
 * drift while pi remains the reference host.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { calculateCost, type Model } from "@earendil-works/pi-ai"

import { calculateCommandCodeCost } from "../src/cost.ts"
import type { Usage } from "../src/types.ts"

type CostTable = Model<"openai-completions">["cost"]

const COST_FIXTURES: Record<string, CostTable> = {
  "zero-cost-model": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "deepseek/deepseek-v4-pro": {
    input: 0.435,
    output: 0.87,
    cacheRead: 0.003625,
    cacheWrite: 0,
  },
  "Qwen/Qwen3.7-Max": { input: 1.25, output: 3.75, cacheRead: 0.25, cacheWrite: 1.56 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
}

const USAGE_CASES = [
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  { input: 812, output: 187, cacheRead: 52_000, cacheWrite: 3_100 },
  { input: 1_000_000, output: 65_536, cacheRead: 998_877, cacheWrite: 123_456 },
  { input: 7, output: 999_999_999, cacheRead: 0.5, cacheWrite: 42 },
]

function piAiModel(id: string, cost: CostTable): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "commandcode",
    baseUrl: "https://api.commandcode.ai",
    reasoning: false,
    input: ["text"],
    cost,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  }
}

function freshUsage(tokens: (typeof USAGE_CASES)[number]): Usage {
  return {
    ...tokens,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

describe("calculateCommandCodeCost()", () => {
  it("matches pi-ai calculateCost exactly for all cost fields", () => {
    for (const [id, cost] of Object.entries(COST_FIXTURES)) {
      const model = piAiModel(id, cost)

      for (const tokens of USAGE_CASES) {
        const ours = freshUsage(tokens)
        const upstream = freshUsage(tokens)

        calculateCommandCodeCost(model, ours)
        calculateCost(model, upstream)

        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
          assert.equal(
            ours.cost[key],
            upstream.cost[key],
            `${id} cost.${key} for tokens=${JSON.stringify(tokens)}`,
          )
        }
      }
    }
  })

  it("writes the total as the sum of all cost components", () => {
    const model = piAiModel("claude-sonnet-4-6", COST_FIXTURES["claude-sonnet-4-6"])
    const usage = freshUsage({ input: 1_000, output: 500, cacheRead: 10_000, cacheWrite: 2_000 })

    calculateCommandCodeCost(model, usage)

    assert.equal(
      usage.cost.total,
      usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite,
    )
    assert.ok(usage.cost.total > 0)
  })
})
