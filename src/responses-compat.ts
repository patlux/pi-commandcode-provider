/**
 * Repairs two Provider API wire quirks the host encoder cannot express.
 *
 * ## 1. Untagged message items
 *
 * pi-ai tags only non-message items (`type: "message"` for assistant text,
 * `function_call`, `function_call_output`, `reasoning`, ...). The leading
 * `system`/`developer` item and every `user` item go out as a bare
 * `{ role, content }` pair. OpenAI accepts that shorthand, but the adapter in
 * front of some models rejects the whole request with
 * `400 invalid_request: input item is missing type` (issue #214,
 * `zai-org/GLM-5.3`). A sweep of all 74 `/responses` models with a minimal text
 * request showed GLM-5.3 is the only one refusing the shorthand, so the rewrite
 * is allowlisted rather than applied to every backend.
 *
 * ## 2. `reasoning.effort: "none"`
 *
 * When thinking is off, pi-ai emits `reasoning: { effort: "none" }` (it reads
 * the level from `thinkingLevelMap`, which has no `off` entry). Some models
 * reject that value — `zai-org/GLM-5.3` with
 * `unsupported output_config.effort: none`, `mistral/mistral-large-4` with
 * `reasoning_effort none is not supported for this model` — while omitting the
 * `reasoning` field entirely succeeds. Declaring `off: null` in
 * `thinkingLevelMap` is not a fix: pi then clamps to the lowest allowed level and
 * sends `effort: "low"`, silently forcing reasoning on. So the field is dropped
 * here instead.
 *
 * Both transforms are no-ops for every other model, for invalid JSON, and for
 * bodies whose shape is not the expected object, because a malformed rewrite
 * would turn a model-specific 400 into a failure for every backend.
 */

/** Model ID -> repairs to apply. Keep it evidence-driven and short. */
export interface ResponsesWireRepair {
  /** Needs an explicit `type: "message"` on role-carrying input items. */
  messageItemType?: boolean
  /** Rejects `reasoning.effort: "none"`; the field is dropped in that case. */
  dropNoneEffort?: boolean
}

/**
 * Per-model repairs. An entry is only added once a live request shows the
 * failure, because none of this is verifiable from the test suite alone.
 */
export const RESPONSES_WIRE_REPAIRS: Readonly<Record<string, ResponsesWireRepair>> = {
  "zai-org/GLM-5.3": { messageItemType: true, dropNoneEffort: true },
  "mistral/mistral-large-4": { dropNoneEffort: true },
}

/** Roles that carry an item-level `message` type in the Responses schema. */
const MESSAGE_ROLES: ReadonlySet<string> = new Set(["system", "developer", "user", "assistant"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Tags every role-carrying input item that has no `type` yet. */
function tagMessageItems(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.input)) return false
  let changed = false
  body.input = body.input.map((item) => {
    if (!isRecord(item) || "type" in item) return item
    if (typeof item.role !== "string" || !MESSAGE_ROLES.has(item.role)) return item
    if (item.content === undefined) return item
    changed = true
    return { type: "message", ...item }
  })
  return changed
}

/** Returns a copy without `reasoning` when the block only says `effort: "none"`. */
function withoutInertReasoning(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const reasoning = body.reasoning
  if (!isRecord(reasoning)) return undefined
  if (Object.keys(reasoning).length !== 1 || reasoning.effort !== "none") return undefined
  const { reasoning: _dropped, ...rest } = body
  return rest
}

/**
 * Applies the repairs for `model`.
 *
 * Returns the original string when nothing changed, so callers can hand the
 * exact bytes through instead of a re-serialized copy.
 */
export function rewriteResponsesBody(
  body: string,
  repairs: Readonly<Record<string, ResponsesWireRepair>> = RESPONSES_WIRE_REPAIRS,
): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (!isRecord(parsed)) return body
  const model = parsed.model
  if (typeof model !== "string" || !Object.hasOwn(repairs, model)) return body
  const repair = repairs[model]
  if (repair.messageItemType !== true && repair.dropNoneEffort !== true) return body
  // Work on copies so a no-op repair never mutates the parsed object.
  let next: Record<string, unknown> = parsed
  let changed = false
  if (repair.messageItemType === true) {
    const tagged = { ...next }
    if (tagMessageItems(tagged)) {
      next = tagged
      changed = true
    }
  }
  if (repair.dropNoneEffort === true) {
    const pruned = withoutInertReasoning(next)
    if (pruned !== undefined) {
      next = pruned
      changed = true
    }
  }
  return changed ? JSON.stringify(next) : body
}

/**
 * Applies {@link rewriteResponsesBody} to the arguments the host passes to
 * `fetch`. Decoded bodies and `Request` objects pass through untouched, and the
 * stale `content-length` is dropped so the transport recomputes it.
 */
export function withResponsesWireRepairs(
  args: Parameters<typeof fetch>,
  repairs: Readonly<Record<string, ResponsesWireRepair>> = RESPONSES_WIRE_REPAIRS,
): Parameters<typeof fetch> {
  const [input, init] = args
  if (typeof init?.body !== "string") return args
  const body = rewriteResponsesBody(init.body, repairs)
  if (body === init.body) return args
  const headers = new Headers(init.headers)
  headers.delete("content-length")
  return [input, { ...init, body, headers }]
}
