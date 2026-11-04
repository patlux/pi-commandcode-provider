/** Compile-only contracts, checked with the installed Pi declarations, never host stubs. */
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent as HostEvent,
} from "@earendil-works/pi-ai"
import { streamSimple } from "@earendil-works/pi-ai/compat"
import type { ProviderConfig } from "@earendil-works/pi-coding-agent"
import { createRequestDiagnostics } from "../../src/diagnostics.ts"
import { createCommandCodeTransportRouter } from "../../src/transport.ts"
import type { AssistantMessageEvent, StreamOptions, ToolCallContent } from "../../src/types.ts"
import type { OAuthCredentials } from "../../src/oauth.ts"

type HostModel = Parameters<typeof streamSimple>[0]
type HostContext = Parameters<typeof streamSimple>[1]
type HostOptions = NonNullable<Parameters<typeof streamSimple>[2]>
type HostReasoning = NonNullable<HostOptions["reasoning"]>

// Event compatibility must work in both directions: core -> host factory and
// native host -> router/instrumentation. Neither boundary may erase JSON types.
export function toHostEvent(event: AssistantMessageEvent): HostEvent {
  return event
}
export function fromHostEvent(event: HostEvent): AssistantMessageEvent {
  return event
}
export function toLocalOptions(options: HostOptions): StreamOptions<HostModel, HostReasoning> {
  return options
}
export function toHostOptions(options: StreamOptions<HostModel, HostReasoning>): HostOptions {
  return options
}
export function toHostCredentials(
  credentials: OAuthCredentials,
): Awaited<ReturnType<NonNullable<ProviderConfig["oauth"]>["login"]>> {
  return credentials
}

const transport = createCommandCodeTransportRouter<HostModel, HostContext, HostReasoning>({
  createStream: createAssistantMessageEventStream,
  streamProvider: streamSimple,
  streamGenerate: streamSimple,
})
const diagnostics = createRequestDiagnostics()
export const measuredStream: NonNullable<ProviderConfig["streamSimple"]> = (
  model,
  context,
  options,
) =>
  diagnostics.stream(transport.stream, createAssistantMessageEventStream, model, context, options)

// Negative contracts: these directives must become TS2578 if a boundary is widened.
export function rejectsInvalidInputs(model: HostModel, context: HostContext) {
  const incomplete = {
    id: model.id,
    api: model.api,
    provider: model.provider,
    maxTokens: 1,
    cost: model.cost,
  }
  // @ts-expect-error Native forwarding must retain the complete host model.
  transport.stream(incomplete, context)
  // @ts-expect-error Host thinking levels are not arbitrary provider effort strings.
  transport.stream(model, context, { reasoning: "unrecognised-effort" })
  // @ts-expect-error Tool arguments on the wire cannot contain functions.
  const args: ToolCallContent["arguments"] = { invalid: () => 1 }
  return args
}
