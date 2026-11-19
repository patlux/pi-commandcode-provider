/**
 * Command Code provider for pi.
 *
 * Uses Command Code's documented Provider API:
 * https://api.commandcode.ai/provider/v1
 */

import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai"
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

import {
  getConfiguredApiKey,
  pickCommandCodeApiKey,
  withResolvedCommandCodeApiKey,
} from "./src/api-key.ts"
import { commandCodeNativeCostRatesAt } from "./src/cost.ts"
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
import { modelWireTraits, withResponsesWireRepairs } from "./src/responses-compat.ts"
import { createCommandCodeRuntime } from "./src/runtime.ts"
import {
  describeZdr,
  loadZdrSettings,
  resolveZdr,
  saveZdrSetting,
  zdrHeaders,
  type ZdrState,
} from "./src/zdr.ts"
import {
  compatForEndpoint,
  endpointChoiceForModel,
  isEndpointChoice,
  loadEndpointOverrides,
  resolveEndpoint,
  saveEndpointChoice,
  type EndpointOverrides,
} from "./src/routing.ts"
import { createCommandCodeUsageProvider, type UsageProvider } from "./src/usage.ts"
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

/**
 * The registered config, plus Oh My Pi's extension-only usage hook.
 *
 * `usage` is not part of pi's `ProviderConfig`; pi ignores the extra field,
 * while OMP turns it into the account's usage report. Both use the same
 * registration call, so the field is attached unconditionally.
 */
type CommandCodeProviderConfig = ProviderConfig & { usage?: UsageProvider }

type NativeModel = Parameters<typeof streamNativeProvider>[0]
type HostContext = Parameters<typeof streamNativeProvider>[1]
type HostReasoning = NonNullable<
  NonNullable<Parameters<typeof streamNativeProvider>[2]>["reasoning"]
>
// Host-specific passthrough flags may be absent from Pi's declarations.
type CommandCodeModelCompat = NonNullable<NativeModel["compat"]> & {
  supportsToolReferences?: boolean
  // OMP's completions encoder requires this opt-in; Pi ignores the extra flag.
  // Verified in @oh-my-pi/pi-ai 18.16.0, src/providers/openai-completions.ts.
  replayReasoningContent?: boolean
  // Private registration metadata, preserved through host/user compat overlays.
  commandCodeWire?: CommandCodeApi
}
// OMP exposes sparse authored/user overrides here; Pi uses `compat`.
type HostModel = NativeModel & { compatConfig?: CommandCodeModelCompat }

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
    replayReasoningContent: model.reasoning,
    maxTokensField: "max_tokens",
  }
}

function createProviderConfig(
  models: readonly CommandCodeModel[],
  apiBase: string,
  streamCommandCode: ProviderConfig["streamSimple"],
  headers: Record<string, string> | undefined,
): CommandCodeProviderConfig {
  // The host merges a re-registration over the previous one and preserves
  // undefined values, so an empty object is what clears a previously sent
  // header after ZDR is turned off.
  const registeredHeaders = headers ?? {}
  return {
    name: "Command Code",
    baseUrl: apiBase,
    apiKey: providerApiKey(),
    api: COMMAND_CODE_API,
    streamSimple: streamCommandCode,
    headers: registeredHeaders,
    // Same alpha endpoints and credentials as the /commandcode-quota command.
    usage: createCommandCodeUsageProvider({
      apiBase: quotaApiBase(apiBase),
      headers: registeredHeaders,
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
      // Registration hands mutable metadata to the host, never the readonly catalog.
      cost: {
        ...(MODEL_COSTS[model.id] ?? ZERO_MODEL_COST),
        tiers: MODEL_COSTS[model.id]?.tiers?.map((tier) => ({ ...tier })),
      },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      headers: registeredHeaders,
      compat: { ...compatForModel(model), commandCodeWire: model.api },
    })),
  }
}

function quotaApiBase(providerApiBase: string): string {
  return providerApiBase.replace(/\/provider\/v1\/?$/, "")
}

export default async function (pi: ExtensionAPI) {
  let pluginVersion = "unknown"
  try {
    const packageData: unknown = JSON.parse(
      await readFile(new URL("./package.json", import.meta.url), "utf8"),
    )
    if (
      typeof packageData === "object" &&
      packageData !== null &&
      "version" in packageData &&
      typeof packageData.version === "string"
    )
      pluginVersion = packageData.version
  } catch {
    // Optional support metadata must not prevent loading the provider.
  }
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
    // Applies the opt-in from the agent settings file and picks up a file
    // changed since the last load.
    await applyHostZdr()
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
  const resolveStreamOptions = (options?: Parameters<typeof streamNativeProvider>[2]) =>
    withResolvedCommandCodeApiKey(options, getConfiguredApiKey())
  // The host dispatches every Command Code model through one custom api id, so
  // the wire each model answers on is resolved here from the catalog that
  // `createProviderConfig` registered. Unknown ids fall back to the id rule.
  const catalogModels = new Map<string, CommandCodeModel>()
  // The environment is readable while extensions load; the agent settings file
  // is read at session start so a change made while the host was stopped applies
  // before the first request. The environment is fixed for the process, and the
  // file only reloads with the extension. /commandcode-zdr updates this state
  // after writing the file.
  const settingsPath = join(getAgentDir(), "settings.json")
  let zdr: ZdrState = resolveZdr(undefined)
  const routingPath = join(getAgentDir(), "commandcode-routing.json")
  let routing: EndpointOverrides = {}
  let routingWarning: string | undefined
  try {
    routing = await loadEndpointOverrides(routingPath)
  } catch (error) {
    routingWarning = `${error instanceof Error ? error.message : "Invalid commandcode-routing.json"}; using catalog routing. Use /commandcode-endpoint <model-id> auto|responses|chat-completions to repair it explicitly.`
    console.error(`[commandcode] routing warning: ${routingWarning}`)
  }
  const resolveModelApi = (modelId: string): CommandCodeApi => {
    const model = catalogModels.get(modelId)
    return model ? resolveEndpoint(model, routing) : apiForModelId(modelId)
  }
  pi.on("before_agent_start", (_event, ctx) => {
    if (routingWarning && ctx.model?.provider === "commandcode") {
      ctx.ui.notify(routingWarning, "warning")
    }
  })
  // waitForIdle is not a lock: serialize command writes within this host so
  // simultaneous callers cannot overwrite one another's unrelated choices.
  let routingWrite = Promise.resolve()
  pi.registerCommand("commandcode-endpoint", {
    description: "Choose a persistent model endpoint: <model-id> auto|responses|chat-completions",
    handler: async (args, ctx) => {
      const [modelId, choice, extra] = args.trim().split(/\s+/)
      if (!modelId || !isEndpointChoice(choice) || extra) {
        ctx.ui.notify(
          "Usage: /commandcode-endpoint <catalog-model-id> auto|responses|chat-completions",
          "warning",
        )
        return
      }
      await ctx.waitForIdle()
      routingWrite = routingWrite
        .catch(() => {})
        .then(async () => {
          try {
            // A refresh can finish while the command is waiting for the current turn.
            const model = catalogModels.get(modelId)
            if (!model) {
              ctx.ui.notify(
                "Unknown catalog model; refresh the catalog or use a listed model ID",
                "warning",
              )
              return
            }
            resolveEndpoint(model, { [model.id]: choice })
            const saved = await saveEndpointChoice(routingPath, model.id, choice)
            routing = saved.overrides
            routingWarning = undefined
            ctx.ui.notify(
              `Command Code endpoint for ${model.id}: ${resolveModelApi(model.id)} (${choice === "auto" ? "catalog" : "user override"}). Applies to the next request and survives refresh/restart.` +
                (saved.backupFile
                  ? ` Invalid routing choices were replaced; previous contents saved as ${saved.backupFile} in the agent directory.`
                  : ""),
              saved.backupFile ? "warning" : "info",
            )
          } catch (error) {
            ctx.ui.notify(
              error instanceof Error ? error.message : "Could not save routing configuration",
              "error",
            )
          }
        })
      await routingWrite
    },
  })
  // Diagnostic for /commandcode-status: reflects the most recent Responses
  // request, so a one-off malformed stream does not stick until restart.
  let streamWarning: string | undefined
  const transport = createCommandCodeTransportRouter<HostModel, HostContext, HostReasoning>({
    createStream: createAssistantMessageEventStream,
    streamProvider: (model, context, options) => {
      const wire = resolveModelApi(model.id)
      const catalogModel = catalogModels.get(model.id)
      const resolvedOptions: Parameters<typeof streamNativeProvider>[2] =
        resolveStreamOptions(options)
      const nativeOptions =
        wire === "openai-responses"
          ? {
              ...resolvedOptions,
              fetch: async (...args: Parameters<typeof fetch>) => {
                streamWarning = undefined
                return normalizeCommandCodeResponsesResponse(
                  await (resolvedOptions?.fetch ?? fetch)(...withResponsesWireRepairs(args)),
                  (warning) => {
                    streamWarning = warning
                  },
                  modelWireTraits(model.id),
                )
              },
            }
          : resolvedOptions
      return streamNativeProvider(
        {
          ...model,
          api: wire,
          // Native hosts receive mutable tiers without owning the readonly catalog.
          cost: commandCodeNativeCostRatesAt(model.id, model.cost),
          // Preserve same-wire host/user settings, but replace unknown/stale
          // compatibility metadata rather than merge flags across wires.
          compat: compatForEndpoint(
            catalogModel,
            wire,
            model.compatConfig ?? model.compat,
            compatForModel,
          ),
        },
        context,
        nativeOptions,
      )
    },
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
    options?: Parameters<typeof streamNativeProvider>[2],
  ) =>
    diagnostics.stream(
      transport.stream,
      createAssistantMessageEventStream,
      model,
      context,
      resolveStreamOptions(options),
    )
  const compatStream: CompatStreamFunction = measuredStream
  registerCompatApiProvider(compatStream)

  const registerProvider = () =>
    pi.registerProvider(
      "commandcode",
      createProviderConfig([...catalogModels.values()], apiBase, measuredStream, zdrHeaders(zdr)),
    )
  const applyHostZdr = async () => {
    // Read the agent settings file, not the host's merged global+project view:
    // the command writes this file, so a project override must not be able to
    // invalidate the persisted opt-in at restart.
    const resolved = resolveZdr(await loadZdrSettings(settingsPath))
    const changed = resolved.enabled !== zdr.enabled
    zdr = resolved
    // Re-registration is the only way to change a registration header, and it
    // needs a catalog to register.
    if (changed && catalogModels.size > 0) registerProvider()
  }

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return
    const normalized = normalizeCommandCodeMessage(event.message, ctx.model?.provider)
    return normalized ? { message: normalized.message } : undefined
  })

  // The opt-in is only sent as a registration header, so a change needs the
  // provider re-registered before it reaches the next request. Re-registering
  // is the same path /commandcode-refresh already uses.
  pi.registerCommand("commandcode-zdr", {
    description: "Show or set zero data retention: /commandcode-zdr [on|off]",
    handler: async (args, ctx) => {
      const [choice, extra] = args.trim().split(/\s+/)
      if (!choice) {
        ctx.ui.notify(
          `Command Code zero data retention: ${describeZdr(zdr)}. Usage: /commandcode-zdr on|off`,
          "info",
        )
        return
      }
      if ((choice !== "on" && choice !== "off") || extra) {
        ctx.ui.notify("Usage: /commandcode-zdr on|off", "warning")
        return
      }
      // Only pi reads this settings file back and applies a re-registered header
      // to the next request; other hosts keep the environment opt-in.
      if (!compatApiProviderRegistrar()) {
        ctx.ui.notify(
          "Saving zero data retention is only supported on pi. Set CMD_ZDR=1 in the environment instead.",
          "warning",
        )
        return
      }
      // The environment wins at resolution time, so refuse instead of writing a
      // setting that would not take effect.
      if (choice === "off" && zdr.source === "env") {
        ctx.ui.notify(
          `Zero data retention is forced on by ${zdr.envVar ?? "the environment"}. Unset that variable to disable it.`,
          "warning",
        )
        return
      }
      await ctx.waitForIdle?.()
      let written: unknown
      try {
        written = await saveZdrSetting(settingsPath, choice === "on")
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "Could not save settings.json",
          "error",
        )
        return
      }
      zdr = resolveZdr(written)
      // Without a catalog there is nothing to register; the next successful
      // load or /commandcode-refresh picks the saved setting up.
      const applied = catalogModels.size > 0
      if (applied) registerProvider()
      ctx.ui.notify(
        `Command Code zero data retention: ${describeZdr(zdr)}. Saved to settings.json; ` +
          (applied
            ? "applies to the next request and survives restart."
            : "applies after the next catalog load or /commandcode-refresh."),
        "info",
      )
    },
  })

  registerCommandCodeQuota(pi, {
    apiBase: quotaApiBase(apiBase),
    headers: () => zdrHeaders(zdr),
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
      return createProviderConfig(models, apiBase, measuredStream, zdrHeaders(zdr))
    },
    getDiagnostics: (model) => {
      let route = "not selected"
      if (model?.provider === "commandcode") {
        try {
          route = `${transport.getTransport()}/${resolveModelApi(model.id)}`
        } catch {
          route = "invalid routing configuration"
        }
      }
      let endpointStatus = "model endpoint: no Command Code model selected"
      if (model?.provider === "commandcode") {
        const choice = endpointChoiceForModel(model.id, routing)
        try {
          if (catalogModels.has(model.id)) {
            const source = choice === "auto" ? "catalog" : "user override"
            endpointStatus = `model endpoint: ${resolveModelApi(model.id)} (${choice}; ${source})`
          } else {
            endpointStatus = `model endpoint: ${resolveModelApi(model.id)} (id-rule fallback; model absent from catalog, stored choices ignored)`
          }
        } catch {
          endpointStatus = "model endpoint: invalid choice for the current catalog; use auto"
        }
      }
      return [
        formatDiagnostics({
          pluginVersion,
          host: compatApiProviderRegistrar() ? "pi" : "omp-compatible",
          hostVersion,
          modelId: model?.provider === "commandcode" ? model.id : undefined,
          route,
          request: diagnostics.snapshot(),
        }),
        endpointStatus,
        `zdr: ${describeZdr(zdr)}`,
        routingWarning,
      ]
        .filter(Boolean)
        .join("\n")
    },
    getTransport: transport.getTransport,
    resetTransport: transport.reset,
    getStreamWarning: () => [routingWarning, streamWarning].filter(Boolean).join("\n") || undefined,
  })

  pi.on("session_shutdown", () => {
    runtime.dispose()
  })

  await runtime.initialize()
}
