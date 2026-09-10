import type { CommandCodeInputType, CommandCodeReasoningEffort } from "./commandcode-catalog.ts"

/**
 * Manual reasoning-effort policy for models the official CLI marks as
 * reasoning-capable without publishing selectable efforts.
 *
 * `src/commandcode-catalog.ts` is generated from the CLI package and must stay
 * byte-identical to upstream so the daily drift check works. Entries here are
 * merged over the generated catalog at load time and are not touched by
 * `npm run sync:commandcode-catalog`.
 *
 * Add a model only when the effort parameter is known to be accepted by the
 * Command Code endpoint; remove it once the CLI catalog ships its own efforts.
 */
export const MODEL_EFFORT_OVERRIDES: Readonly<
  Record<string, readonly CommandCodeReasoningEffort[]>
> = {
  // Meta Muse Spark: the CLI ships no effort levels, but the endpoint accepts
  // `reasoning_effort` for these models and other hosts expose the same set.
  "meta/muse-spark-1.1": ["minimal", "low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2": ["minimal", "low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2-contributor": ["minimal", "low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.3": ["minimal", "low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.3-contributor": ["minimal", "low", "medium", "high", "xhigh"],
}

/**
 * Manual input-modality overrides for models the generated catalog predates.
 *
 * Same rationale as the effort overrides above: the generated catalog is pinned
 * to one CLI release, so a model published afterwards is absent from
 * `MODEL_INPUT_MODALITIES` and falls back to `["text"]`. Both transports honor
 * the absence: the provider transport publishes `input: ["text"]` to the host
 * and the generate transport refuses image blocks outright.
 *
 * The Provider API model list carries no modality metadata, so the CLI registry
 * is the only source available for this. Add a model only when the CLI registry
 * declares `image` for it; remove it once the generated catalog ships the same
 * modalities.
 */
export const MODEL_INPUT_MODALITIES_OVERRIDES: Readonly<
  Record<string, readonly CommandCodeInputType[]>
> = {
  // Served by the Provider API and declared with
  // `inputModalities:["text","image"]` by command-code@1.53.0.
  "deepseek/deepseek-v4.1-flash": ["text", "image"],
  "xai/grok-4.6": ["text", "image"],
}
