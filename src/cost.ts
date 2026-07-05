/**
 * Local cost calculation for Command Code usage.
 *
 * Mirrors pi-ai's `calculateCost` arithmetic exactly. The provider ships its
 * own copy because Oh My Pi's legacy pi-ai shim does not export
 * `calculateCost`, which broke extension installation there (issue #24).
 * `tests/test-cost.ts` locks this implementation to the pi-ai original.
 */

import type { ModelLike, Usage } from "./types.ts"

export function calculateCommandCodeCost(model: ModelLike, usage: Usage): void {
  usage.cost.input = (model.cost.input / 1_000_000) * usage.input
  usage.cost.output = (model.cost.output / 1_000_000) * usage.output
  usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead
  usage.cost.cacheWrite = (model.cost.cacheWrite / 1_000_000) * usage.cacheWrite
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite
}
