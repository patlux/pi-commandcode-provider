import type { CommandCodeReasoningEffort } from "./commandcode-catalog.ts"

/**
 * Manual reasoning-effort policy for models the official CLI marks as
 * reasoning-capable without publishing selectable efforts.
 *
 * `src/commandcode-catalog.ts` is generated from the CLI package and must stay
 * byte-identical to upstream so the daily drift check works. Entries here are
 * merged over the generated catalog at load time. `npm run sync:commandcode-catalog`
 * deletes an entry as soon as upstream publishes its own levels, so nothing has to
 * be removed by hand.
 *
 * An entry only takes effect for a model the generated catalog already marks as
 * reasoning-capable: `src/core.ts` drops `reasoning_effort` when `model.reasoning`
 * is false, and a model missing from `MODEL_REASONING` stays false. Upstream emits
 * the flag whenever it emits efforts, so a sync that brings in new efforts brings
 * the flag with it.
 *
 * Keep shared rationale above the declaration. The sync parses this object
 * literal and preserves neighboring declarations; review entry-specific comments
 * after pruning because they may describe removed entries.
 *
 * Add a model only when the effort parameter is known to be accepted by the
 * Command Code endpoint.
 */
export const MODEL_EFFORT_OVERRIDES: Readonly<
  Record<string, readonly CommandCodeReasoningEffort[]>
> = {}
