import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  commandCodeCostRatesAt,
  commandCodeNativeCostRatesAt,
  isDeepSeekV4Peak,
} from "../src/cost.ts"
import type { ModelCost, ModelCostRates, ModelCostTier } from "../src/types.ts"
type CostTable = ModelCostRates & { tiers?: ModelCostTier[] }
const OFF_PEAK_WEEKDAY = Date.parse("2026-09-28T05:00:00Z")
const PEAK_WEEKDAY = Date.parse("2026-09-28T06:00:00Z")

describe("native Provider API request-time cost rates", () => {
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

  it("keeps and doubles context tiers of a full cost table during peak windows", () => {
    // No time-priced model ships tiers today; this guards the provider path,
    // which hands the host the whole table including `tiers`.
    const table = {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.003,
      cacheWrite: 0,
      tiers: [
        { inputTokensAbove: 128_000, input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
      ],
    }
    assert.deepEqual(commandCodeCostRatesAt("deepseek/deepseek-v4-flash", table, PEAK_WEEKDAY), {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.006,
      cacheWrite: 0,
      tiers: [
        { inputTokensAbove: 128_000, input: 0.6, output: 2.4, cacheRead: 0.012, cacheWrite: 0 },
      ],
    })
    assert.equal(
      commandCodeCostRatesAt("deepseek/deepseek-v4-flash", table, OFF_PEAK_WEEKDAY),
      table,
    )
    // Models without time-based pricing return the table untouched.
    assert.equal(commandCodeCostRatesAt("claude-sonnet-4-6", table, PEAK_WEEKDAY), table)
  })

  it("gives native hosts mutable cost tiers without sharing the readonly catalog", () => {
    const tier = Object.freeze({
      inputTokensAbove: 128_000,
      input: 0.3,
      output: 1.2,
      cacheRead: 0.006,
      cacheWrite: 0,
    })
    const table: ModelCost = Object.freeze({
      input: 0.15,
      output: 0.6,
      cacheRead: 0.003,
      cacheWrite: 0,
      tiers: Object.freeze([tier]),
    })
    for (const [modelId, atMs] of [
      ["deepseek/deepseek-v4-flash", PEAK_WEEKDAY],
      ["deepseek/deepseek-v4-flash", OFF_PEAK_WEEKDAY],
      ["claude-sonnet-4-6", PEAK_WEEKDAY],
    ] as const) {
      // Native Pi/OMP cost contracts allow a mutable tiers array. Keep this
      // assignment in the project typecheck, which does not cover index.ts.
      const nativeCost: CostTable = commandCodeNativeCostRatesAt(modelId, table, atMs)
      assert.deepEqual(nativeCost, commandCodeCostRatesAt(modelId, table, atMs))
      assert.notEqual(nativeCost, table)
      assert.notEqual(nativeCost.tiers, table.tiers)
      assert.notEqual(nativeCost.tiers?.[0], tier)
      const nativeTiers = nativeCost.tiers
      if (!nativeTiers) throw new Error("Expected native cost tiers")
      nativeTiers.push({ ...tier, inputTokensAbove: 256_000 })
      nativeTiers[0].input = 999
      assert.equal(table.tiers?.length, 1)
      assert.equal(tier.input, 0.3)
    }
  })

  it("keeps native costs without tiers or with empty tiers usable", () => {
    const base = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 }
    const plain: CostTable = commandCodeNativeCostRatesAt("claude-sonnet-4-6", base, PEAK_WEEKDAY)
    assert.equal(plain.input, 1)
    assert.equal(plain.tiers, undefined)
    const empty: CostTable = commandCodeNativeCostRatesAt(
      "deepseek/deepseek-v4-flash",
      { ...base, tiers: Object.freeze([]) },
      PEAK_WEEKDAY,
    )
    assert.equal(empty.input, 2)
    assert.equal(empty.tiers?.length, 0)
    empty.tiers?.push({ ...base, inputTokensAbove: 128_000 })
    assert.equal(empty.tiers?.length, 1)
  })

  it("keeps every time-priced model and unrelated models on the correct native rates", () => {
    const base = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 }
    for (const id of [
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash-vision-exp",
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash-fast",
    ]) {
      assert.equal(commandCodeNativeCostRatesAt(id, base, PEAK_WEEKDAY).input, 0.3, id)
      assert.equal(commandCodeNativeCostRatesAt(id, base, OFF_PEAK_WEEKDAY).input, 0.15, id)
    }
    assert.deepEqual(commandCodeNativeCostRatesAt("Qwen/Qwen3.7-Max", base, PEAK_WEEKDAY), {
      ...base,
      tiers: undefined,
    })
  })
})
