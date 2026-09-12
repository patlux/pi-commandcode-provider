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
 * Keep one self-contained entry per line and keep the rationale above the
 * declaration: the sync rewrites individual entry lines and cannot preserve a
 * comment block that describes only some of them.
 *
 * Add a model only when the effort parameter is known to be accepted by the
 * Command Code endpoint.
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
