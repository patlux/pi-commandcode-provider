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
 * Models are sourced from models.json, which is extracted from the command-code
 * npm package dist file. Run `npx tsx scripts/extract-models.ts` to refresh.
 */

import { AssistantMessageEventStream, calculateCost } from "@mariozechner/pi-ai"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

import { createStreamCommandCode, DEFAULT_API_BASE } from "./src/core.ts"
import { getApiKey, login, refreshToken } from "./src/oauth.ts"
import modelsJson from "./models.json" with { type: "json" }

const API_BASE = process.env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE

// ---------------------------------------------------------------------------
// Load model definitions from models.json
// ---------------------------------------------------------------------------

interface ModelsJson {
  providers: Record<string, string>
  models: Array<{
    key: string
    id: string
    provider: string
    spec: string
    label: string
    name: string
    description: string
    reasoning: boolean
    reasoningEfforts: string[] | null
    contextWindow: number
    maxOutputTokens: number
    vendorLabel: string | null
  }>
  pricing: Array<{
    provider: string
    id: string
    category: string
    promptCost: number
    completionCost: number
    cacheWrite5mCost: number
    cacheWrite1hCost: number
    cacheHitCost: number
  }>
}

const typedModelsJson = modelsJson as ModelsJson

// ---------------------------------------------------------------------------
// Build cost lookup (model id -> pricing)
// ---------------------------------------------------------------------------

const costByModelId = new Map<string, ModelsJson["pricing"][number]>()
for (const p of typedModelsJson.pricing) {
  // Pricing id is like "anthropic:claude-sonnet-4-6"
  const colonIdx = p.id.indexOf(":")
  if (colonIdx > 0) {
    costByModelId.set(p.id.substring(colonIdx + 1), p)
  }
  costByModelId.set(p.id, p)
}

// ---------------------------------------------------------------------------
// Build pi model list (all defaults come from models.json)
// ---------------------------------------------------------------------------

const MODELS = typedModelsJson.models.map((m) => {
  const cost = costByModelId.get(m.id)
  return {
    id: m.id,
    name: `${m.name} (CC)`,
    reasoning: m.reasoning,
    contextWindow: m.contextWindow,
    maxTokens: m.maxOutputTokens,
    cost: {
      input: cost?.promptCost ?? 0,
      output: cost?.completionCost ?? 0,
      cacheRead: cost?.cacheHitCost ?? 0,
      cacheWrite: Math.max(cost?.cacheWrite5mCost ?? 0, cost?.cacheWrite1hCost ?? 0),
    },
  }
})

// ---------------------------------------------------------------------------
// Stream factory
// ---------------------------------------------------------------------------

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
    apiKey: "COMMANDCODE_API_KEY",
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
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  })
}
