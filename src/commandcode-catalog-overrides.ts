import type { CommandCodeReasoningEffort } from "./commandcode-catalog.ts"

/**
 * Manual reasoning-flag policy for models the official CLI marks as
 * reasoning-capable but that are missing from the pinned catalog.
 *
 * `src/commandcode-catalog.ts` is generated from the CLI package and must stay
 * byte-identical to upstream so the daily drift check works, so a model added
 * upstream after the last sync has no reasoning flag until the catalog is
 * regenerated. `MODEL_REASONING` gates everything downstream
 * (`src/core.ts` drops `reasoning_effort` without it and `index.ts` derives
 * `compat.supportsReasoningEffort` from the effort list), so an efforts-only
 * override is not enough.
 *
 * Add a model only when the upstream CLI bundle marks it `reasoning:!0`;
 * remove it once the generated catalog carries the flag.
 */
export const MODEL_REASONING_OVERRIDES: Readonly<Record<string, true>> = {
  // Command Code CLI 1.53.0: DEEPSEEK_V4_1_FLASH {reasoning:!0,
  // reasoningEfforts:["low","high","max"]}; absent from the pinned catalog.
  "deepseek/deepseek-v4.1-flash": true,
}

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

  // Command Code CLI 1.53.0 publishes these efforts upstream; the pinned
  // catalog predates the model and therefore carries neither flag nor efforts.
  "deepseek/deepseek-v4.1-flash": ["low", "high", "max"],
}
