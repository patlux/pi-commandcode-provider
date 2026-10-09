import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { format } from "prettier"
import { COMMAND_CODE_CLI_VERSION } from "../src/commandcode-catalog.ts"
import {
  MODEL_EFFORTS,
  MODEL_INPUT_MODALITIES,
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_REASONING,
} from "../src/models.ts"
import { MODEL_COSTS, PRICING_LAST_VERIFIED } from "../src/pricing.ts"

const target = fileURLToPath(
  new URL(
    "../packages/pig-commandcode-provider/extensions/pig-commandcode-provider/catalog.json",
    import.meta.url,
  ),
)
const ids = [
  ...new Set([
    ...Object.keys(MODEL_INPUT_MODALITIES),
    ...Object.keys(MODEL_REASONING),
    ...Object.keys(MODEL_MAX_OUTPUT_TOKENS),
    ...Object.keys(MODEL_COSTS),
  ]),
].sort()
const snapshot = await format(
  JSON.stringify(
    {
      cliVersion: COMMAND_CODE_CLI_VERSION,
      pricingLastVerified: PRICING_LAST_VERIFIED,
      models: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            input: MODEL_INPUT_MODALITIES[id] ?? ["text"],
            reasoning: MODEL_REASONING[id] === true,
            efforts: MODEL_EFFORTS[id] ?? [],
            maxTokens: MODEL_MAX_OUTPUT_TOKENS[id] ?? 65_536,
            cost: MODEL_COSTS[id] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ]),
      ),
    },
    null,
    2,
  ),
  { parser: "json" },
)
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== snapshot) {
    throw new Error(`Stale native catalog: run npm run generate:pig-catalog (${target})`)
  }
  console.log("Native catalog matches authoritative TypeScript metadata and pricing")
} else {
  await writeFile(target, snapshot)
  console.log(`Generated ${target}`)
}
