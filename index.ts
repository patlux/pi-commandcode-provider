/**
 * Command Code provider for pi.
 *
 * Connects pi to Command Code's API (https://api.commandcode.ai/alpha/generate).
 * The provider uses pi's legacy extension registration surface because the
 * current pi host exposes `registerProvider(name, config)`, including OMP.
 */

import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import { join } from "node:path"

import { COMMAND_CODE_CLI_VERSION, createStreamCommandCode, DEFAULT_API_BASE } from "./src/core.ts"
import { calculateCommandCodeCost } from "./src/cost.ts"
import {
  DEFAULT_MODELS_URL,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCommandCodeModels,
  thinkingMetadataForModel,
  type CommandCodeModel,
} from "./src/models.ts"
import { getApiKey as getOAuthApiKey, login, refreshToken } from "./src/oauth.ts"
import { MODEL_COSTS, ZERO_MODEL_COST } from "./src/pricing.ts"
import { createCommandCodeRuntime } from "./src/runtime.ts"
import { normalizeCommandCodeMessage } from "./src/overflow.ts"

function createProviderConfig(
  models: readonly CommandCodeModel[],
  apiBase: string,
  streamCommandCode: ProviderConfig["streamSimple"],
): ProviderConfig {
  return {
    name: "Command Code",
    baseUrl: apiBase,
    // Keep environment authentication dynamic. OAuth credentials are resolved
    // by pi's oauth registration, while the custom stream retains its own
    // request-time legacy-file fallback for older compatible hosts.
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
      getApiKey: getOAuthApiKey,
    },
    models: models.map(createProviderModel),
  }
}

function createProviderModel(model: {
  id: string
  name: string
  reasoning: boolean
  contextWindow: number
  maxTokens: number
}) {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(thinkingMetadataForModel(model.id) ?? {}),
    input: inputModalitiesForModel(model.id),
    cost: MODEL_COSTS[model.id] ?? ZERO_MODEL_COST,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  } as const
}

export default async function (pi: ExtensionAPI) {
  const apiBase = process.env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE
  const modelsUrl = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
  const modelsTimeoutMs = getModelsTimeoutMs()
  const modelsCachePath =
    process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json")
  const streamCommandCode = createStreamCommandCode({
    createStream: () => new AssistantMessageEventStream(),
    calculateCost: calculateCommandCodeCost,
    apiBase,
  })

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return
    const normalized = normalizeCommandCodeMessage(event.message, ctx.model?.provider)
    return normalized ? { message: normalized.message } : undefined
  })

  const runtime = createCommandCodeRuntime<ProviderConfig, ExtensionCommandContext>(pi, {
    endpoint: modelsUrl,
    cachePath: modelsCachePath,
    loadModels: () =>
      loadCommandCodeModels({
        url: modelsUrl,
        cachePath: modelsCachePath,
        timeoutMs: modelsTimeoutMs,
      }),
    createProviderConfig: (models) => createProviderConfig(models, apiBase, streamCommandCode),
  })

  await runtime.initialize()
}
