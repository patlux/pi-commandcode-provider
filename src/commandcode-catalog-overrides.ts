import type { CommandCodeReasoningEffort } from "./commandcode-catalog.ts"

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
  // Empty since command-code@1.54.0: the CLI catalog publishes effort levels itself
  // for every model it lists, including the Meta Muse Spark models this table used
  // to carry (muse-spark-1.1/1.2/1.2-contributor/1.3/1.3-contributor).
}
