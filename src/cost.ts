/** Request-time Provider API rates; the native host calculates usage costs. */

import type { ModelCost, ModelCostRates, ModelCostTier } from "./types.ts"

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

function doubledRates<T extends ModelCostRates>(rates: T): T {
  return {
    ...rates,
    input: rates.input * 2,
    output: rates.output * 2,
    cacheRead: rates.cacheRead * 2,
    cacheWrite: rates.cacheWrite * 2,
  }
}

/**
 * Select request-time rates for the native provider transport. DeepSeek V4 peak rates are exactly 2x off-peak.
 * Context tiers on a full model cost table are kept and doubled alongside
 * the base rates so the host's tier selection still applies during peak.
 */
export function commandCodeCostRatesAt<
  T extends ModelCostRates & { tiers?: readonly ModelCostTier[] },
>(modelId: string, rates: T, atMs: number = Date.now()): T {
  if (!DEEPSEEK_V4_TIME_PRICED_MODELS.has(modelId) || !isDeepSeekV4Peak(atMs)) return rates

  const doubled = doubledRates(rates)
  if (!rates.tiers) return doubled
  return { ...doubled, tiers: rates.tiers.map((tier) => doubledRates(tier)) }
}

/**
 * Native hosts accept mutable cost tiers, while our catalog is readonly.
 * Give the host its own table, array, and tier objects at that boundary.
 */
export function commandCodeNativeCostRatesAt(
  modelId: string,
  rates: ModelCost,
  atMs: number = Date.now(),
): ModelCostRates & { tiers?: ModelCostTier[] } {
  const selected = commandCodeCostRatesAt(modelId, rates, atMs)
  return { ...selected, tiers: selected.tiers?.map((tier) => ({ ...tier })) }
}
