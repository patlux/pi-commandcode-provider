/**
 * Command Code provider for pi.
 *
 * Uses Command Code's documented Provider API:
 * https://api.commandcode.ai/provider/v1
 */

import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import * as piAiCompat from "@earendil-works/pi-ai/compat"
import { streamSimple as streamNativeProvider } from "@earendil-works/pi-ai/compat"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import * as hostPackage from "@earendil-works/pi-coding-agent"
import { createRequestDiagnostics, formatDiagnostics, priceStatus } from "./src/diagnostics.ts"

import { getConfiguredApiKey } from "./src/api-key.ts"
import { pickCommandCodeApiKey, withResolvedCommandCodeApiKey } from "./src/converters.ts"
import { createStreamCommandCode } from "./src/core.ts"
import { calculateCommandCodeCost, commandCodeCostRatesAt } from "./src/cost.ts"
import {
  apiForModelId,
  baseUrlForModel,
  DEFAULT_MODELS_URL,
  DEFAULT_PROVIDER_API_BASE,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCachedCommandCodeModels,
  loadCommandCodeModels,
  MODEL_EFFORTS,
  thinkingMetadataForModel,
  type CommandCodeApi,
  type CommandCodeModel,
} from "./src/models.ts"
import { getApiKey as getOAuthApiKey, login, refreshToken } from "./src/oauth.ts"
import { normalizeCommandCodeMessage } from "./src/overflow.ts"
import { MODEL_COSTS, ZERO_MODEL_COST } from "./src/pricing.ts"
import { registerCommandCodeQuota } from "./src/quota-command.ts"
import { normalizeCommandCodeResponsesResponse } from "./src/responses-stream.ts"
import { createCommandCodeRuntime } from "./src/runtime.ts"
import {
  isEndpointChoice,
  loadEndpointOverrides,
  resolveEndpoint,
  saveEndpointChoice,
  type EndpointOverrides,
} from "./src/routing.ts"
import { createCommandCodeUsageProvider, type UsageProvider } from "./src/usage.ts"
import { transcriptReadersFrom, withTranscriptPromptAndTools } from "./src/transcript.ts"
import { createCommandCodeTransportRouter } from "./src/transport.ts"

const COMMAND_CODE_API = "commandcode-custom"
const COMPAT_SOURCE_ID = "pi-commandcode-provider"

type CompatStreamFunction = (
  model: Parameters<typeof streamNativeProvider>[0],
  context: Parameters<typeof streamNativeProvider>[1],
  options?: Parameters<typeof streamNativeProvider>[2],
) => AssistantMessageEventStream

/**
 * pi's compat entrypoint exposes `registerApiProvider`; Oh My Pi maps
 * `@earendil-works/pi-ai/compat` onto its own pi-ai, which lacks that export
 * and registers custom APIs itself inside `registerProvider`. Resolve the
 * function at runtime so the extension loads on both hosts.
 */
function compatApiProviderRegistrar(): ((...args: unknown[]) => unknown) | undefined {
  const register = (piAiCompat as { registerApiProvider?: unknown }).registerApiProvider
  return typeof register === "function" ? (register as (...args: unknown[]) => unknown) : undefined
}

function registerCompatApiProvider(stream: CompatStreamFunction): void {
  compatApiProviderRegistrar()?.(
    { api: COMMAND_CODE_API, stream, streamSimple: stream },
    COMPAT_SOURCE_ID,
  )
}

/**
 * The `apiKey` handed to `registerProvider` means different things per host.
 *
 * pi parses `$COMMAND_CODE_API_KEY` as an env template: unresolved means
 * "not configured", so `/login` credentials and `--api-key` take over, and
 * the entry keeps the API-key auth method registered next to OAuth. Without
 * it pi composes an OAuth-only provider and drops stored `api_key`
 * credentials and `--api-key`.
 *
 * Oh My Pi has no template notion: an unresolved value stays a literal config
 * override that shadows its `/login` credential store and is sent verbatim as
 * `Authorization: Bearer $COMMAND_CODE_API_KEY`. There, omit `apiKey` unless
 * a real key is configured; OMP then reads env keys and stored credentials
 * itself.
 *
 * Hosts are told apart by the same `registerApiProvider` probe used for the
 * compat registry: pi exports it, OMP does not.
 */
function providerApiKey(): string | undefined {
  const configured = pickCommandCodeApiKey(getConfiguredApiKey(), undefined)
  if (configured) return configured
  return compatApiProviderRegistrar() ? "$COMMAND_CODE_API_KEY" : undefined
}

function commandCodeHeaders(): Record<string, string> | undefined {
  if (process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1") {
    return { "x-cmd-zdr": "1" }
  }
  return undefined
}

/**
 * The registered config, plus Oh My Pi's extension-only usage hook.
 *
 * `usage` is not part of pi's `ProviderConfig`; pi ignores the extra field,
 * while OMP turns it into the account's usage report. Both use the same
 * registration call, so the field is attached unconditionally.
 */
type CommandCodeProviderConfig = ProviderConfig & { usage?: UsageProvider }

type CommandCodeModelCompat = NonNullable<ProviderConfig["models"]>[number]["compat"]

/**
 * Compatibility flags per wire. Chat Completions mirrors what the Provider API
 * accepts for open models; Responses leaves pi's defaults (store off, encrypted
 * reasoning) and only mutes the OpenAI extras Command Code does not advertise;
 * Anthropic keeps the existing Claude tuning.
 */
function compatForModel(model: CommandCodeModel): CommandCodeModelCompat {
  if (model.api === "openai-responses") {
    return {
      supportsDeveloperRole: false,
      supportsLongCacheRetention: false,
      sessionAffinityFormat: "openai-nosession",
    }
  }
  if (model.api === "anthropic-messages") {
    return {
      supportsEagerToolInputStreaming: false,
      supportsLongCacheRetention: false,
      supportsCacheControlOnTools: false,
      supportsToolReferences: false,
      ...(model.reasoning ? { forceAdaptiveThinking: true } : {}),
    }
  }
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: MODEL_EFFORTS[model.id] !== undefined,
    maxTokensField: "max_tokens",
  }
}

function createProviderConfig(
  models: readonly CommandCodeModel[],
  apiBase: string,
  streamCommandCode: ProviderConfig["streamSimple"],
): CommandCodeProviderConfig {
  const headers = commandCodeHeaders()
  return {
    name: "Command Code",
    baseUrl: apiBase,
    apiKey: providerApiKey(),
    api: COMMAND_CODE_API,
    streamSimple: streamCommandCode,
    headers,
    // Same alpha endpoints and credentials as the /commandcode-quota command.
    usage: createCommandCodeUsageProvider({
      apiBase: legacyApiBase(apiBase),
      headers,
    }),
    oauth: {
      name: "Command Code",
      login,
      refreshToken,
      getApiKey: getOAuthApiKey,
    },
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      api: COMMAND_CODE_API,
      baseUrl: baseUrlForModel(apiBase, model.api),
      reasoning: model.reasoning,
      ...(thinkingMetadataForModel(model.id) ?? {}),
      input: [...inputModalitiesForModel(model.id)],
      cost: MODEL_COSTS[model.id] ?? ZERO_MODEL_COST,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      headers,
      compat: compatForModel(model),
    })),
  }
}

function legacyApiBase(providerApiBase: string): string {
  return providerApiBase.replace(/\/provider\/v1\/?$/, "")
}

export default async function (pi: ExtensionAPI) {
  const packageData: unknown = JSON.parse(
    await readFile(new URL("./package.json", import.meta.url), "utf8"),
  )
  const pluginVersion =
    typeof packageData === "object" &&
    packageData !== null &&
    "version" in packageData &&
    typeof packageData.version === "string"
      ? packageData.version
      : "unknown"
  const hostVersion =
    "VERSION" in hostPackage && typeof hostPackage.VERSION === "string"
      ? hostPackage.VERSION
      : "unknown"
  const diagnostics = createRequestDiagnostics()
  const warnedPrices = new Set<string>()
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.model?.provider !== "commandcode" || warnedPrices.has(ctx.model.id)) return
    if (priceStatus(ctx.model.id) === "known") return
    warnedPrices.add(ctx.model.id)
    ctx.ui.notify(
      "Command Code display price is unknown or needs review. A zero estimate does not mean free usage; check /commandcode-diagnostics.",
      "warning",
    )
  })
  // Hosts may select their built-in Command Code model before loading extensions.
  // Rebind that stale selection to our registered transport before the first turn.
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.model?.provider !== "commandcode") return
    const registered = ctx.modelRegistry.find("commandcode", ctx.model.id)
    if (registered?.api === COMMAND_CODE_API && ctx.model.api !== COMMAND_CODE_API) {
      await pi.setModel(registered)
    }
  })
  const apiBase = process.env.COMMANDCODE_API_BASE ?? DEFAULT_PROVIDER_API_BASE
  const modelsUrl = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
  const modelsTimeoutMs = getModelsTimeoutMs()
  const modelsCachePath =
    process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json")
  const streamGenerate = createStreamCommandCode({
    createStream: () => new AssistantMessageEventStream(),
    calculateCost: calculateCommandCodeCost,
    apiBase: legacyApiBase(apiBase),
  })
  const resolveStreamOptions = (options?: Parameters<typeof streamNativeProvider>[2]) =>
    withResolvedCommandCodeApiKey(options, getConfiguredApiKey())
  // The provider transport delegates to pi-ai, which reads the transcript
  // itself. The generate transport builds its own request body and needs the
  // flat prompt and tool fields that pi 0.86+ no longer passes.
  const transcriptReaders = transcriptReadersFrom(piAiCompat)
  // The host dispatches every Command Code model through one custom api id, so
  // the wire each model answers on is resolved here from the catalog that
  // `createProviderConfig` registered. Unknown ids fall back to the id rule.
  const catalogModels = new Map<string, CommandCodeModel>()
  const routingPath = join(getAgentDir(), "commandcode-routing.json")
  let routing: EndpointOverrides = {}
  let routingWarning: string | undefined
  try {
    routing = await loadEndpointOverrides(routingPath)
  } catch (error) {
    routingWarning = error instanceof Error ? error.message : "Invalid routing configuration"
  }
  const resolveModelApi = (modelId: string): CommandCodeApi => {
    if (routingWarning) throw new Error(routingWarning)
    const model = catalogModels.get(modelId)
    return model ? resolveEndpoint(model, routing) : apiForModelId(modelId)
  }
  pi.registerCommand("commandcode-endpoint", {
    description: "Choose a persistent model endpoint: <model-id> auto|responses|chat-completions",
    handler: async (args, ctx) => {
      const [modelId, choice, extra] = args.trim().split(/\s+/)
      const model = catalogModels.get(modelId ?? "")
      if (!model || !isEndpointChoice(choice) || extra) {
        ctx.ui.notify(
          "Usage: /commandcode-endpoint <catalog-model-id> auto|responses|chat-completions",
          "warning",
        )
        return
      }
      await ctx.waitForIdle()
      try {
        resolveEndpoint(model, { [model.id]: choice })
        routing = await saveEndpointChoice(routingPath, model.id, choice)
        routingWarning = undefined
        ctx.ui.notify(
          `Command Code endpoint for ${model.id}: ${resolveModelApi(model.id)} (${choice === "auto" ? "catalog" : "user override"}). Applies to the next request and survives refresh/restart.`,
          "info",
        )
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "Could not save routing configuration",
          "error",
        )
      }
    },
  })
  let streamWarning: string | undefined
  const transport = createCommandCodeTransportRouter({
    createStream: () => new AssistantMessageEventStream(),
    streamProvider: (model, context, options) => {
      const wire = resolveModelApi(model.id)
      const catalogModel = catalogModels.get(model.id)
      const resolvedOptions: Parameters<typeof streamNativeProvider>[2] =
        resolveStreamOptions(options)
      const nativeOptions =
        wire === "openai-responses"
          ? {
              ...resolvedOptions,
              fetch: async (...args: Parameters<typeof fetch>) =>
                normalizeCommandCodeResponsesResponse(
                  await (resolvedOptions?.fetch ?? fetch)(...args),
                  (warning) => {
                    streamWarning = warning
                  },
                ),
            }
          : resolvedOptions
      return streamNativeProvider(
        {
          ...model,
          api: wire,
          cost: commandCodeCostRatesAt(model.id, model.cost),
          compat: {
            ...(model.compatConfig ?? model.compat),
            // A selected host model can outlive a command or background refresh.
            // Wire-specific defaults must follow the actual request, not that stale model.
            ...(catalogModel ? compatForModel({ ...catalogModel, api: wire }) : {}),
          },
        },
        context,
        nativeOptions,
      )
    },
    streamGenerate: (model, context, options) =>
      streamGenerate(
        model,
        withTranscriptPromptAndTools(context, transcriptReaders),
        resolveStreamOptions(options),
      ),
  })

  // pi dispatches the main chat through the registered provider, but sibling
  // extensions that call `streamSimple` from `@earendil-works/pi-ai/compat`
  // with a Command Code model resolve `model.api` through the compat
  // api-registry, which knows nothing about extension providers. Register the
  // custom api there so those calls reach the same transport. The registry
  // resolves no credentials for extension providers, so fall back to the
  // configured key when the caller passes none or a placeholder.
  const measuredStream = (
    model: Parameters<typeof transport.stream>[0],
    context: Parameters<typeof transport.stream>[1],
    options?: Parameters<typeof transport.stream>[2],
  ) =>
    diagnostics.stream(
      transport.stream,
      () => new AssistantMessageEventStream(),
      model,
      context,
      resolveStreamOptions(options),
    )
  const compatStream: CompatStreamFunction = (model, context, options) =>
    measuredStream(model, context, options) as AssistantMessageEventStream
  registerCompatApiProvider(compatStream)

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return
    const normalized = normalizeCommandCodeMessage(event.message, ctx.model?.provider)
    return normalized ? { message: normalized.message } : undefined
  })

  registerCommandCodeQuota(pi, {
    apiBase: legacyApiBase(apiBase),
    headers: commandCodeHeaders(),
  })

  const runtime = createCommandCodeRuntime<ProviderConfig, ExtensionCommandContext>(pi, {
    endpoint: modelsUrl,
    cachePath: modelsCachePath,
    loadModels: (signal) =>
      loadCommandCodeModels({
        url: modelsUrl,
        cachePath: modelsCachePath,
        timeoutMs: modelsTimeoutMs,
        signal,
      }),
    loadCachedModels: () => loadCachedCommandCodeModels(modelsCachePath),
    createProviderConfig: (models) => {
      catalogModels.clear()
      for (const model of models) catalogModels.set(model.id, model)
      return createProviderConfig(models, apiBase, measuredStream)
    },
    getDiagnostics: (model) => {
      let route = "not selected"
      if (model?.provider === "commandcode") {
        try {
          route = `${transport.getTransport()}/${resolveModelApi(model.id)} (${routing[model.id] ?? "auto"})`
        } catch {
          route = "invalid routing configuration"
        }
      }
      return formatDiagnostics({
        pluginVersion,
        host: compatApiProviderRegistrar() ? "pi" : "omp-compatible",
        hostVersion,
        modelId: model?.provider === "commandcode" ? model.id : undefined,
        route,
        request: diagnostics.snapshot(),
      })
    },
    getRoutingStatus: (model) => {
      if (routingWarning) return `routing warning: ${routingWarning}`
      if (model?.provider !== "commandcode") return "model endpoint: no Command Code model selected"
      try {
        return `model endpoint: ${resolveModelApi(model.id)} (${routing[model.id] ?? "auto"}; ${routing[model.id] ? "user override" : "catalog"})`
      } catch (error) {
        return `routing warning: ${error instanceof Error ? error.message : "Invalid route"}`
      }
    },
    getTransport: transport.getTransport,
    getStreamWarning: () => streamWarning,
  })

  pi.on("session_shutdown", () => {
    runtime.dispose()
  })

  await runtime.initialize()
}
