/**
 * Command Code provider for pi.
 *
 * Connects pi to Command Code's API (https://api.commandcode.ai/alpha/generate).
 *
 * Authentication (pick one):
 *   1. Run `/login`, then select Command Code — opens browser to commandcode.ai, auto-stores API key
 *   2. Set COMMANDCODE_API_KEY environment variable
 *   3. Place API key in `~/.commandcode/auth.json` or `~/.pi/agent/auth.json`
 *      as {"apiKey": "user_..."} or {"commandcode": "user_..."}
 *
 * Models are fetched from Command Code's Provider API at startup.
 */

import { AssistantMessageEventStream, calculateCost } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import { COMMAND_CODE_CLI_VERSION, createStreamCommandCode, DEFAULT_API_BASE } from "./src/core.ts"
import { DEFAULT_MODELS_URL, fetchCommandCodeModels } from "./src/models.ts"
import { getApiKey, login, refreshToken } from "./src/oauth.ts"

const API_BASE = process.env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE
const MODELS_URL = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL

type CommandCodeModelCost = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const ZERO_MODEL_COST: CommandCodeModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

// The Provider API supplies the current model list. Keep known display pricing
// here until the Provider API exposes prices directly.
const MODEL_COSTS: Record<string, CommandCodeModelCost> = {
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.3-codex": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "google/gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  "google/gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.03, cacheWrite: 0 },
  // 4× usage deal: 75% off (permanent, no expiry)
  "deepseek/deepseek-v4-pro": { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
  "deepseek/deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  "moonshotai/Kimi-K2.6": { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
  "moonshotai/Kimi-K2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  "zai-org/GLM-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  "zai-org/GLM-5": { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
  "MiniMaxAI/MiniMax-M2.7": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  "MiniMaxAI/MiniMax-M2.5": { input: 0.27, output: 0.95, cacheRead: 0.03, cacheWrite: 0 },
  "Qwen/Qwen3.6-Max-Preview": { input: 1.3, output: 7.8, cacheRead: 0.26, cacheWrite: 1.63 },
  "Qwen/Qwen3.6-Plus": { input: 0.5, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  // 2× usage deal: 50% off through June 22, 2026
  "Qwen/Qwen3.7-Max": { input: 1.25, output: 3.75, cacheRead: 0.25, cacheWrite: 1.56 },
  "stepfun/Step-3.5-Flash": { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 },
  "xiaomi/mimo-v2.5-pro": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "xiaomi/mimo-v2.5": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

const streamCommandCode = createStreamCommandCode({
  createStream: () => new AssistantMessageEventStream(),
  calculateCost,
  apiBase: API_BASE,
})

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const models = await fetchCommandCodeModels({ url: MODELS_URL })

  pi.registerProvider("commandcode", {
    name: "Command Code",
    baseUrl: API_BASE,
    apiKey: "$COMMANDCODE_API_KEY",
    authHeader: true,
    api: "commandcode-custom",
    streamSimple: streamCommandCode,
    headers: {
      "x-command-code-version": COMMAND_CODE_CLI_VERSION,
      "x-cli-environment": "production",
    },
    oauth: {
      name: "Command Code",
      login,
      refreshToken,
      getApiKey,
    },
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: ["text"] as const,
      cost: MODEL_COSTS[model.id] ?? ZERO_MODEL_COST,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  })
}
