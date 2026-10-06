/**
 * Local cost calculation for Command Code usage.
 *
 * Mirrors pi-ai's `calculateCost` arithmetic exactly. The provider ships its
 * own copy because Oh My Pi's legacy pi-ai shim does not export
 * `calculateCost`, which broke extension installation there (issue #24).
 * `tests/test-cost.ts` locks this implementation to the pi-ai original.
 */

import type { ModelCostRates, ModelLike, Usage } from "./types.ts"

const DEEPSEEK_V4_TIME_PRICED_MODELS = new Set([
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4.1-flash-fast",
])

/**
 * Command Code documents DeepSeek V4 peak pricing on weekdays from
 * 01:00-04:00 and 06:00-10:00 UTC. Weekends are entirely off-peak.
 */
export function isDeepSeekV4Peak(atMs: number): boolean {
  const at = new Date(atMs)
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false

  const hour = at.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/**
 * Select request-time rates for both the native provider transport and the
 * local generate fallback. DeepSeek V4 peak rates are exactly 2x off-peak.
 */
export function commandCodeCostRatesAt(
  modelId: string,
  rates: ModelCostRates,
  atMs: number = Date.now(),
): ModelCostRates {
  if (!DEEPSEEK_V4_TIME_PRICED_MODELS.has(modelId) || !isDeepSeekV4Peak(atMs)) return rates

  return {
    input: rates.input * 2,
    output: rates.output * 2,
    cacheRead: rates.cacheRead * 2,
    cacheWrite: rates.cacheWrite * 2,
  }
}

export function calculateCommandCodeCost(
  model: ModelLike,
  usage: Usage,
  atMs: number = Date.now(),
): void {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite
  let rates: ModelCostRates = model.cost
  let matchedThreshold = -1
  for (const tier of model.cost.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier
      matchedThreshold = tier.inputTokensAbove
    }
  }
  rates = commandCodeCostRatesAt(model.id, rates, atMs)

  const longWrite = usage.cacheWrite1h ?? 0
  const shortWrite = usage.cacheWrite - longWrite
  usage.cost.input = (rates.input / 1_000_000) * usage.input
  usage.cost.output = (rates.output / 1_000_000) * usage.output
  usage.cost.cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead
  usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1_000_000
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite
}
