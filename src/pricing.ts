export interface CommandCodeModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface CommandCodeModelCostTier extends CommandCodeModelCostRates {
  inputTokensAbove: number
}

export interface CommandCodeModelCost extends CommandCodeModelCostRates {
  tiers?: readonly CommandCodeModelCostTier[]
}

export interface TemporaryPricing {
  models: readonly string[]
  expiresOn: string
  description: string
}

export const PRICING_SOURCE_URL = "https://commandcode.ai/docs/resources/pricing-limits"
export const PRICING_LAST_VERIFIED = "2026-09-06"

export const ZERO_MODEL_COST: CommandCodeModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

/**
 * Display prices in USD per million tokens.
 *
 * Context-dependent rates use pi's request-wide input pricing tiers. The
 * highest threshold exceeded by input + cache reads + cache writes applies to
 * the full request. The Command Code usage page remains authoritative for the
 * amount billed for an individual request.
 */
export const MODEL_COSTS: Readonly<Record<string, CommandCodeModelCost>> = {
  // Free models
  "poolside/laguna-s-2.1-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "meituan/LongCat-2.0:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },

  // Open and open-weight models
  "tencent/hy3-paid": { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0 },
  "tencent/hy4-preview": { input: 0.834, output: 2.501, cacheRead: 0.042, cacheWrite: 0 },
  "moonshotai/Kimi-K3": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
  "moonshotai/Kimi-K2.7-Code": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
  "moonshotai/Kimi-K2.7-Code-Highspeed": {
    input: 1.9,
    output: 8,
    cacheRead: 0.38,
    cacheWrite: 0,
  },
  "moonshotai/Kimi-K2.6": { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
  "moonshotai/Kimi-K2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  "z-ai/glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
  "zai-org/GLM-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  "zai-org/GLM-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  "zai-org/GLM-5.2-Fast": { input: 3, output: 10.25, cacheRead: 0.5, cacheWrite: 0 },
  "zai-org/GLM-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  "zai-org/GLM-5": { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
  "MiniMaxAI/MiniMax-M3": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  "MiniMaxAI/MiniMax-M2.7": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  "MiniMaxAI/MiniMax-M2.5": { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
  // DeepSeek V4 uses time-dependent rates. Display the documented off-peak
  // rates, which apply for 17 hours per day; the Usage page remains authoritative.
  "deepseek/deepseek-v4-pro": {
    input: 0.66,
    output: 1.98,
    cacheRead: 0.022,
    cacheWrite: 0,
  },
  "deepseek/deepseek-v4-flash": {
    input: 0.22,
    output: 0.66,
    cacheRead: 0.007,
    cacheWrite: 0,
  },
  "deepseek/deepseek-v4-flash-vision-exp": {
    input: 0.22,
    output: 0.66,
    cacheRead: 0.007,
    cacheWrite: 0,
  },
  "deepseek/deepseek-v4-flash-fast": {
    input: 0.28,
    output: 0.56,
    cacheRead: 0.07,
    cacheWrite: 0,
  },
  "Qwen/Qwen3.8-Max": { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
  "Qwen/Qwen3.8-Max-0902": { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 0 },
  "Qwen/Qwen3.8-27B": { input: 0.4, output: 3, cacheRead: 0.04, cacheWrite: 0 },
  "Qwen/Qwen3.8-Flash": { input: 0.16, output: 0.47, cacheRead: 0.016, cacheWrite: 0 },
  "Qwen/Qwen3.7-Max": { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.13 },
  "Qwen/Qwen3.7-Plus": {
    input: 0.4,
    output: 1.6,
    cacheRead: 0.08,
    cacheWrite: 0.5,
    tiers: [
      {
        inputTokensAbove: 256_000,
        input: 1.2,
        output: 4.8,
        cacheRead: 0.24,
        cacheWrite: 1.5,
      },
    ],
  },
  "Qwen/Qwen3.7-Flash": {
    input: 0.03,
    output: 0.13,
    cacheRead: 0.006,
    cacheWrite: 0.038,
    tiers: [
      {
        inputTokensAbove: 32_000,
        input: 0.1,
        output: 0.4,
        cacheRead: 0.02,
        cacheWrite: 0.125,
      },
      {
        inputTokensAbove: 256_000,
        input: 0.2,
        output: 0.8,
        cacheRead: 0.04,
        cacheWrite: 0.25,
      },
    ],
  },
  "Qwen/Qwen3.6-Max-Preview": {
    input: 1.3,
    output: 7.8,
    cacheRead: 0.26,
    cacheWrite: 1.63,
  },
  "Qwen/Qwen3.6-Plus": { input: 0.5, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  "stepfun/Step-3.7-Flash": { input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 },
  "stepfun/Step-3.5-Flash": { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 },
  // Permanent discounted rates.
  "xiaomi/mimo-v2.5-pro": { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 },
  "xiaomi/mimo-v2.5": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  "nvidia/nemotron-3-ultra-550b-a55b": {
    input: 0.6,
    output: 2.4,
    cacheRead: 0.12,
    cacheWrite: 0,
  },
  "sakana/fugu-ultra": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "thinkingmachines/inkling": { input: 1, output: 4.05, cacheRead: 0.17, cacheWrite: 0 },
  "thinkingmachines/inkling-small": {
    input: 0.5,
    output: 1.2,
    cacheRead: 0.1,
    cacheWrite: 0,
  },
  "meta/muse-spark-1.1": { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
  "meta/muse-spark-1.2": { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
  "meta/muse-spark-1.2-contributor": {
    input: 0.1,
    output: 0.2,
    cacheRead: 0.002,
    cacheWrite: 0,
  },
  "meta/muse-spark-1.3": { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
  "meta/muse-spark-1.3-contributor": {
    input: 0.1,
    output: 0.2,
    cacheRead: 0.002,
    cacheWrite: 0,
  },

  // Anthropic
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-haiku-4-5-20251001": {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  },

  // OpenAI
  "gpt-6-astra": {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    tiers: [
      {
        inputTokensAbove: 272_000,
        input: 20,
        output: 75,
        cacheRead: 2,
        cacheWrite: 12.5,
      },
    ],
  },
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.3-codex": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },

  // Google and xAI
  "google/gemini-3.8-flash": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
  "google/gemini-3.7-flash": {
    input: 1.5,
    output: 7.5,
    cacheRead: 0.15,
    cacheWrite: 0.08334,
  },
  "google/gemini-3.6-flash": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
  "google/gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  "google/gemini-3.5-flash-lite": {
    input: 0.3,
    output: 2.5,
    cacheRead: 0.03,
    cacheWrite: 0,
  },
  "google/gemini-3.1-flash-lite": {
    input: 0.25,
    output: 1.5,
    cacheRead: 0.03,
    cacheWrite: 0,
  },
  "xai/grok-4.5": { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
  "xai/grok-4.6": {
    input: 2,
    output: 6,
    cacheRead: 0.5,
    cacheWrite: 0,
    tiers: [
      {
        inputTokensAbove: 200_000,
        input: 4,
        output: 12,
        cacheRead: 1,
        cacheWrite: 0,
      },
    ],
  },
}

export const TEMPORARY_PRICING: readonly TemporaryPricing[] = []
