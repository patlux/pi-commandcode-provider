import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"

import {
  checkCommandCodePricing,
  parsePricingPage,
  pricingPageIdCandidates,
  renderPricingReport,
  runPricingCheck,
  runPricingCheckCli,
  type PricingPageRow,
} from "../.github/scripts/check-commandcode-pricing.ts"
import { DEFAULT_MODELS_URL } from "../src/models.ts"
import { PRICING_SOURCE_URL, type CommandCodeModelCost } from "../src/pricing.ts"

const fixtureUrl = new URL("./fixtures/commandcode-pricing-page.html", import.meta.url)
const fixtureHtml = await readFile(fixtureUrl, "utf-8")
const AT_MS = Date.UTC(2026, 9, 5, 12, 0, 0)
const SUPPORTED_WINDOWS = "01–04 & 06–10 UTC, Mon–Fri"

function cost(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): CommandCodeModelCost {
  return { input, output, cacheRead, cacheWrite }
}

function ratesJson(rates: {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}) {
  return {
    input: rates.input,
    output: rates.output,
    cacheRead: rates.cacheRead,
    cacheWrite: rates.cacheWrite,
  }
}

function pageRow(
  id: string,
  rowCost: CommandCodeModelCost,
  extra: Partial<PricingPageRow> = {},
): PricingPageRow {
  return { id, cost: rowCost, ...extra }
}

function findRow(rows: readonly PricingPageRow[], id: string): PricingPageRow {
  const row = rows.find((candidate) => candidate.id === id)
  assert.ok(row, `expected fixture row ${id}`)
  return row
}

function rowsRecord(rows: unknown): string {
  return `34:${JSON.stringify(["$", "$L53", null, { rows }])}\n`
}

function pushScript(flightText: string): string {
  return `<script>self.__next_f.push(${JSON.stringify([1, flightText])})</script>`
}

function pageWithRows(rows: unknown, extraFlight = ""): string {
  return pushScript(extraFlight + rowsRecord(rows))
}

function modelsBody(ids: readonly string[]) {
  return { object: "list", data: ids.map((id) => ({ id, name: id, context_length: 1_000 })) }
}

function fakeFetch(routes: { models?: unknown; page?: string; pageStatus?: number }) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    if (url === DEFAULT_MODELS_URL) {
      return new Response(JSON.stringify(routes.models ?? modelsBody(["model"])), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url === PRICING_SOURCE_URL) {
      const status = routes.pageStatus ?? 200
      return new Response(routes.page ?? "", {
        status,
        statusText: status === 200 ? "OK" : "Service Unavailable",
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }) as typeof fetch
  return { impl, calls }
}

async function captureCli(
  fetchImpl: typeof fetch,
  options: { atMs?: number; localCosts?: Readonly<Record<string, CommandCodeModelCost>> } = {},
) {
  let stdout = ""
  let stderr = ""
  const code = await runPricingCheckCli({
    args: [],
    fetchImpl,
    atMs: options.atMs ?? AT_MS,
    localCosts: options.localCosts,
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  })
  return { code, stdout, stderr }
}

describe("parsePricingPage with the live snapshot fixture", () => {
  const rows = parsePricingPage(fixtureHtml)

  it("parses exactly 89 unique rows", () => {
    assert.equal(rows.length, 89)
    assert.equal(new Set(rows.map((row) => row.id.toLowerCase())).size, 89)
  })

  it("extracts DeepSeek V4.1 Flash Fast base and peak rates", () => {
    const row = findRow(rows, "deepseek-v4.1-flash-fast")
    assert.deepEqual(ratesJson(row.cost), {
      input: 0.16,
      output: 0.58,
      cacheRead: 0.016,
      cacheWrite: 0,
    })
    assert.ok(row.timeOfDay)
    assert.deepEqual(row.timeOfDay.offPeak, {
      input: 0.16,
      output: 0.58,
      cacheRead: 0.016,
      cacheWrite: 0,
    })
    assert.deepEqual(row.timeOfDay.peak, {
      input: 0.32,
      output: 1.16,
      cacheRead: 0.032,
      cacheWrite: 0,
    })
  })

  it("extracts the gpt-6.1-sol long-context tier", () => {
    const row = findRow(rows, "gpt-6.1-sol")
    assert.deepEqual(ratesJson(row.cost), { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 })
    assert.deepEqual(row.cost.tiers, [
      { inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
    ])
  })

  it("extracts Qwen 3.7 Flash thresholds", () => {
    const row = findRow(rows, "qwen-3.7-flash")
    assert.deepEqual(
      row.cost.tiers?.map((tier) => tier.inputTokensAbove),
      [32_000, 256_000],
    )
  })

  it("collapses MiniMax M3 tiers that repeat the base rates", () => {
    const row = findRow(rows, "minimax-m3")
    assert.equal(row.cost.tiers, undefined)
  })
})

describe("parsePricingPage shape handling", () => {
  it("accepts script end tags with HTML whitespace", () => {
    const page = pageWithRows([{ id: "m", tiers: [{ rates: { input: 1, output: 2 } }] }])
    for (const whitespace of [" ", "\t", "\n", "\r", "\f", " \t\n"]) {
      const rows = parsePricingPage(page.replace("</script>", `</SCRIPT${whitespace}>`))
      assert.equal(rows[0]!.id, "m")
    }
  })

  it("reconstructs one row split across two push chunks", () => {
    const record = rowsRecord([{ id: "split-model", tiers: [{ rates: { input: 1, output: 2 } }] }])
    const split = Math.floor(record.length / 2)
    const rows = parsePricingPage(
      pushScript(record.slice(0, split)) + pushScript(record.slice(split)),
    )
    assert.deepEqual(
      rows.map((row) => row.id),
      ["split-model"],
    )
  })

  it("ignores unrelated props.models payloads", () => {
    const payload = ["$", "$L9", null, { models: [{ id: "budget" }] }]
    const modelsRecord = `35:${JSON.stringify(payload)}\n`
    const rows = parsePricingPage(
      pageWithRows([{ id: "only-row", tiers: [{ rates: { input: 1, output: 2 } }] }], modelsRecord),
    )
    assert.deepEqual(
      rows.map((row) => row.id),
      ["only-row"],
    )
  })

  it("rejects pages without exactly one valid rows payload", () => {
    assert.throws(() => parsePricingPage(""), /exactly one pricing rows payload/)
    assert.throws(
      () =>
        parsePricingPage(pushScript(`35:${JSON.stringify(["$", "$L9", null, { models: [] }])}\n`)),
      /exactly one pricing rows payload/,
    )
    assert.throws(() => parsePricingPage(pageWithRows([])), /non-empty array/)
    assert.throws(
      () =>
        parsePricingPage(
          pageWithRows([{ id: "a", tiers: [{ rates: { input: 1, output: 1 } }] }]) +
            pageWithRows([{ id: "b", tiers: [{ rates: { input: 1, output: 1 } }] }]),
        ),
      /exactly one pricing rows payload/,
    )
    assert.throws(() => parsePricingPage(pushScript('34:[{"rows":')), /Malformed pricing page/)
    assert.throws(
      () =>
        parsePricingPage(
          pageWithRows([
            { id: "Dup", tiers: [{ rates: { input: 1, output: 1 } }] },
            { id: "dup", tiers: [{ rates: { input: 1, output: 1 } }] },
          ]),
        ),
      /Duplicate pricing row id/,
    )
  })
})

describe("pricing rate and context validation", () => {
  it("treats an absent cache column as explicit zero", () => {
    const rows = parsePricingPage(
      pageWithRows([{ id: "zero", tiers: [{ rates: { input: 0, output: 0 } }] }]),
    )
    assert.deepEqual(rows[0]!.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it("rejects malformed rate and context shapes", () => {
    const rateCases: [string, unknown][] = [
      ["missing input", { output: 1 }],
      ["missing output", { input: 1 }],
      ["null cacheWrite", { input: 1, output: 1, cacheWrite: null }],
      ["negative input", { input: -1, output: 1 }],
      ["string input", { input: "1", output: 1 }],
    ]
    for (const [label, rates] of rateCases) {
      assert.throws(
        () => parsePricingPage(pageWithRows([{ id: "m", tiers: [{ rates }] }])),
        Error,
        label,
      )
    }

    const contextCases: [string, unknown][] = [
      ["lone above band", [{ context: "> 272K", rates: { input: 1, output: 1 } }]],
      [
        "non-increasing bounds",
        [
          { context: "≤ 256K", rates: { input: 1, output: 1 } },
          { context: "≤ 128K", rates: { input: 2, output: 2 } },
          { context: "> 128K", rates: { input: 3, output: 3 } },
        ],
      ],
      [
        "last above does not match",
        [
          { context: "≤ 272K", rates: { input: 1, output: 1 } },
          { context: "> 128K", rates: { input: 2, output: 2 } },
        ],
      ],
      ["unknown single context", [{ context: "up to 32K", rates: { input: 1, output: 1 } }]],
      ["zero single context", [{ context: "≤ 0K", rates: { input: 1, output: 1 } }]],
    ]
    for (const [label, tiers] of contextCases) {
      assert.throws(() => parsePricingPage(pageWithRows([{ id: "m", tiers }])), Error, label)
    }
  })
})

describe("pricing page id matching", () => {
  it("derives page id candidates from API ids and aliases", () => {
    assert.deepEqual(pricingPageIdCandidates("tencent/hy4-preview"), [
      "tencent/hy4-preview",
      "hy4-preview",
    ])
    assert.deepEqual(pricingPageIdCandidates("moonshotai/Kimi-K3"), [
      "moonshotai/kimi-k3",
      "kimi-k3",
    ])
    assert.deepEqual(pricingPageIdCandidates("Qwen/Qwen3.8-Max"), [
      "qwen/qwen3.8-max",
      "qwen-3.8-max",
    ])
    assert.deepEqual(pricingPageIdCandidates("claude-haiku-4-5-20251001"), [
      "claude-haiku-4-5-20251001",
      "claude-haiku-4-5",
    ])
    assert.deepEqual(pricingPageIdCandidates("Qwen/Qwen3.6-Max-Preview"), [
      "qwen/qwen3.6-max-preview",
      "qwen-3.6-max",
    ])
    assert.deepEqual(pricingPageIdCandidates("nvidia/nemotron-3-ultra-550b-a55b"), [
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nemotron-3-ultra",
    ])
  })

  it("flags ambiguous page rows instead of picking the first match", () => {
    const pageRows = [pageRow("vendor/model", cost(1, 1, 0, 0)), pageRow("model", cost(1, 1, 0, 0))]
    const result = checkCommandCodePricing(
      ["vendor/model"],
      pageRows,
      { "vendor/model": cost(1, 1, 0, 0) },
      AT_MS,
    )
    assert.deepEqual(
      result.issues.map((issue) => issue.kind),
      ["ambiguous-page-row"],
    )
  })

  it("flags two API ids that share one page row", () => {
    const pageRows = [pageRow("model", cost(1, 1, 0, 0))]
    const result = checkCommandCodePricing(
      ["a/model", "b/model"],
      pageRows,
      { "a/model": cost(1, 1, 0, 0), "b/model": cost(1, 1, 0, 0) },
      AT_MS,
    )
    assert.deepEqual(
      result.issues.map((issue) => issue.kind),
      ["ambiguous-page-row", "ambiguous-page-row"],
    )
  })

  it("reports a missing page row", () => {
    const result = checkCommandCodePricing(
      ["missing/model"],
      [],
      { "missing/model": cost(1, 1, 0, 0) },
      AT_MS,
    )
    assert.deepEqual(
      result.issues.map((issue) => issue.kind),
      ["missing-page-row"],
    )
  })
})

describe("advertised model without a local price", () => {
  const apiModels = ["deepseek/deepseek-v4.1-flash-fast"]
  const fixtureRows = parsePricingPage(fixtureHtml)
  const flashFastRow = findRow(fixtureRows, "deepseek-v4.1-flash-fast")

  it("reports missing-local-price, then CLI exit 1", async () => {
    const { impl } = fakeFetch({ models: modelsBody(apiModels), page: fixtureHtml })
    const result = await runPricingCheck({ fetchImpl: impl, atMs: AT_MS, localCosts: {} })
    assert.deepEqual(
      result.issues.map((issue) => issue.kind),
      ["missing-local-price"],
    )

    const cli = await captureCli(impl, { localCosts: {} })
    assert.equal(cli.code, 1)
    assert.match(cli.stdout, /deepseek\/deepseek-v4\.1-flash-fast/)
  })

  it("passes when the local rates and runtime policy match V4.1 Flash Fast", async () => {
    const localCosts = { "deepseek/deepseek-v4.1-flash-fast": flashFastRow.cost }
    const { impl } = fakeFetch({ models: modelsBody(apiModels), page: fixtureHtml })
    const result = await runPricingCheck({ fetchImpl: impl, atMs: AT_MS, localCosts })
    assert.deepEqual(result.issues, [])

    const cli = await captureCli(impl, { localCosts })
    assert.equal(cli.code, 0)
  })

  it("passes for a model whose page row and runtime policy agree", async () => {
    const modelId = "deepseek/deepseek-v4-flash-fast"
    const row = findRow(fixtureRows, "deepseek-v4-flash-fast")
    const localCosts = { [modelId]: row.cost }
    const { impl } = fakeFetch({ models: modelsBody([modelId]), page: fixtureHtml })
    const result = await runPricingCheck({ fetchImpl: impl, atMs: AT_MS, localCosts })
    assert.deepEqual(result.issues, [])

    const cli = await captureCli(impl, { localCosts })
    assert.equal(cli.code, 0)
  })

  it("does not import filesystem write APIs", async () => {
    const source = await readFile(
      new URL("../.github/scripts/check-commandcode-pricing.ts", import.meta.url),
      "utf-8",
    )
    assert.doesNotMatch(source, /node:fs/)
  })
})

describe("changed cost detection", () => {
  it("reports a changed flat price with both sides", () => {
    const pageRows = [pageRow("flat-model", cost(2, 3, 0, 0))]
    const result = checkCommandCodePricing(
      ["flat-model"],
      pageRows,
      { "flat-model": cost(1, 3, 0, 0) },
      AT_MS,
    )
    assert.deepEqual(
      result.issues.map((issue) => issue.kind),
      ["changed-cost"],
    )
    assert.match(result.issues[0]!.detail, /current=/)
    assert.match(result.issues[0]!.detail, /upstream=/)
  })

  it("reports a changed local threshold", () => {
    const pageRows = [
      pageRow("gpt-6.1-sol", {
        input: 2,
        output: 10,
        cacheRead: 0.1,
        cacheWrite: 2.5,
        tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
      }),
    ]
    const local = {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272_001, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    }
    const result = checkCommandCodePricing(
      ["gpt-6.1-sol"],
      pageRows,
      { "gpt-6.1-sol": local },
      AT_MS,
    )
    assert.deepEqual(
      result.issues.map((issue) => issue.kind),
      ["changed-cost"],
    )
  })

  it("reports a missing local long-context tier", () => {
    const rows = parsePricingPage(
      pageWithRows([
        {
          id: "qwen-3.6-plus",
          tiers: [
            { context: "≤ 256K", rates: { input: 0.5, output: 3, cacheRead: 0.1 } },
            { context: "> 256K", rates: { input: 2, output: 6, cacheRead: 0.2 } },
          ],
        },
      ]),
    )
    const result = checkCommandCodePricing(
      ["Qwen/Qwen3.6-Plus"],
      rows,
      { "Qwen/Qwen3.6-Plus": cost(0.5, 3, 0.1, 0) },
      AT_MS,
    )
    assert.deepEqual(
      result.issues.map((issue) => issue.kind),
      ["changed-cost"],
    )
  })

  it("accepts two identical upstream tiers after normalization", () => {
    const rows = parsePricingPage(
      pageWithRows([
        {
          id: "minimax-m3",
          tiers: [
            { context: "≤ 512K", rates: { input: 0.3, output: 1.2, cacheRead: 0.06 } },
            { context: "> 512K", rates: { input: 0.3, output: 1.2, cacheRead: 0.06 } },
          ],
        },
      ]),
    )
    const result = checkCommandCodePricing(
      ["MiniMaxAI/MiniMax-M3"],
      rows,
      { "MiniMaxAI/MiniMax-M3": cost(0.3, 1.2, 0.06, 0) },
      AT_MS,
    )
    assert.deepEqual(result.issues, [])
  })

  it("lists unused page rows without blocking stale local prices", () => {
    const pageRows = [
      pageRow("live-model", cost(1, 2, 0, 0)),
      pageRow("informational-row", cost(9, 9, 0, 0)),
    ]
    const result = checkCommandCodePricing(
      ["live-model"],
      pageRows,
      { "live-model": cost(1, 2, 0, 0), "retired/model": cost(5, 5, 0, 0) },
      AT_MS,
    )
    assert.deepEqual(result.issues, [])
    assert.deepEqual(result.unusedPageIds, ["informational-row"])
  })

  it("rejects invalid model ids and local thresholds", () => {
    assert.throws(() => checkCommandCodePricing([], [], {}, AT_MS), /at least one model id/)
    assert.throws(() => checkCommandCodePricing(["a", "a"], [], {}, AT_MS), /Duplicate model id/)
    assert.throws(() => checkCommandCodePricing([""], [], {}, AT_MS), /non-empty strings/)
    assert.throws(() => checkCommandCodePricing(["m"], [], {}, Number.NaN), /finite timestamp/)

    const pageRows = [pageRow("m", cost(1, 2, 0, 0))]
    assert.throws(
      () =>
        checkCommandCodePricing(
          ["m"],
          pageRows,
          { m: { ...cost(1, 2, 0, 0), input: Number.POSITIVE_INFINITY } },
          AT_MS,
        ),
      /finite non-negative/,
    )
    assert.throws(
      () =>
        checkCommandCodePricing(
          ["m"],
          pageRows,
          { m: { ...cost(1, 2, 0, 0), tiers: [{ inputTokensAbove: 0, ...cost(1, 2, 0, 0) }] } },
          AT_MS,
        ),
      /positive integer/,
    )
    assert.throws(
      () =>
        checkCommandCodePricing(
          ["m"],
          pageRows,
          {
            m: {
              ...cost(1, 2, 0, 0),
              tiers: [
                { inputTokensAbove: 10, ...cost(2, 2, 0, 0) },
                { inputTokensAbove: 10, ...cost(3, 2, 0, 0) },
              ],
            },
          },
          AT_MS,
        ),
      /strictly increase/,
    )
  })
})

describe("time-priced models", () => {
  const fixtureRows = parsePricingPage(fixtureHtml)

  it("accepts the current DeepSeek page and runtime policy", () => {
    const modelIds = ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash-fast"]
    const localCosts = {
      "deepseek/deepseek-v4-flash": findRow(fixtureRows, "deepseek-v4-flash").cost,
      "deepseek/deepseek-v4-flash-fast": findRow(fixtureRows, "deepseek-v4-flash-fast").cost,
    }
    const result = checkCommandCodePricing(modelIds, fixtureRows, localCosts, AT_MS)
    assert.deepEqual(result.issues, [])
  })

  it("flags a page-only time policy the runtime does not implement", () => {
    const modelId = "new-time-model"
    const pageRows = [
      pageRow(modelId, cost(0.1, 0.2, 0, 0), {
        timeOfDay: {
          offPeak: cost(0.1, 0.2, 0, 0),
          peak: cost(0.2, 0.4, 0, 0),
          windows: SUPPORTED_WINDOWS,
          effective: "2026-08-16T16:00:00Z",
        },
      }),
    ]
    const result = checkCommandCodePricing(
      [modelId],
      pageRows,
      { [modelId]: cost(0.1, 0.2, 0, 0) },
      AT_MS,
    )
    assert.deepEqual(
      result.issues.map((issue) => issue.kind),
      ["time-policy"],
    )
    assert.match(result.issues[0]!.detail, /2026-10-05T01:00:00\.000Z/)
  })

  it("detects a removed time policy for a runtime time-priced model", () => {
    const row = findRow(fixtureRows, "deepseek-v4-flash")
    const result = checkCommandCodePricing(
      ["deepseek/deepseek-v4-flash"],
      [pageRow(row.id, row.cost)],
      { "deepseek/deepseek-v4-flash": row.cost },
      AT_MS,
    )
    assert.deepEqual(
      result.issues.map((issue) => issue.kind),
      ["time-policy"],
    )
  })

  it("detects a changed peak multiplier and an unsupported window", () => {
    const row = findRow(fixtureRows, "deepseek-v4-flash")
    const changedPeak = pageRow(row.id, row.cost, {
      timeOfDay: { ...row.timeOfDay!, peak: cost(0.99, 1.2, 0.006, 0) },
    })
    const peakResult = checkCommandCodePricing(
      ["deepseek/deepseek-v4-flash"],
      [changedPeak],
      { "deepseek/deepseek-v4-flash": row.cost },
      AT_MS,
    )
    assert.deepEqual(
      peakResult.issues.map((issue) => issue.kind),
      ["time-policy"],
    )

    const unsupported = pageRow(row.id, row.cost, {
      timeOfDay: { ...row.timeOfDay!, windows: "01:00-04:00 UTC" },
    })
    const windowResult = checkCommandCodePricing(
      ["deepseek/deepseek-v4-flash"],
      [unsupported],
      { "deepseek/deepseek-v4-flash": row.cost },
      AT_MS,
    )
    assert.deepEqual(
      windowResult.issues.map((issue) => issue.kind),
      ["time-policy"],
    )
    assert.match(windowResult.issues[0]!.detail, /window/i)
  })

  it("allows effective exactly at atMs and flags a future effective date", () => {
    const row = findRow(fixtureRows, "deepseek-v4-flash")
    const localCosts = { "deepseek/deepseek-v4-flash": row.cost }

    const atNow = pageRow(row.id, row.cost, {
      timeOfDay: { ...row.timeOfDay!, effective: new Date(AT_MS).toISOString() },
    })
    assert.deepEqual(
      checkCommandCodePricing(["deepseek/deepseek-v4-flash"], [atNow], localCosts, AT_MS).issues,
      [],
    )

    const future = pageRow(row.id, row.cost, {
      timeOfDay: { ...row.timeOfDay!, effective: new Date(AT_MS + 3_600_000).toISOString() },
    })
    const flagged = checkCommandCodePricing(
      ["deepseek/deepseek-v4-flash"],
      [future],
      localCosts,
      AT_MS,
    )
    assert.deepEqual(
      flagged.issues.map((issue) => issue.kind),
      ["time-policy"],
    )
    assert.match(flagged.issues[0]!.detail, /Future effective/)
  })
})

describe("promotions and deals", () => {
  const modelId = "deal-model"
  const localCosts = { [modelId]: cost(1, 2, 0, 0) }

  function dealRow(expires?: string, endsWhen?: string): PricingPageRow {
    return pageRow(modelId, cost(1, 2, 0, 0), {
      deal: {
        id: "deal-1",
        discountPercent: 50,
        free: false,
        ...(expires ? { expires } : {}),
        ...(endsWhen ? { endsWhen } : {}),
      },
    })
  }

  it("treats a date-only deal as active through the last moment of the UTC day", () => {
    const row = dealRow("2026-06-22")
    const active = checkCommandCodePricing(
      [modelId],
      [row],
      localCosts,
      Date.UTC(2026, 5, 22, 23, 59, 59, 999),
    )
    assert.deepEqual(active.issues, [])
    assert.equal(active.deals.length, 1)

    const expired = checkCommandCodePricing([modelId], [row], localCosts, Date.UTC(2026, 5, 23))
    assert.deepEqual(
      expired.issues.map((issue) => issue.kind),
      ["expired-deal"],
    )
  })

  it("treats an ISO timestamp deal as expired exactly at the timestamp", () => {
    const expires = "2026-06-22T12:00:00Z"
    const row = dealRow(expires)
    const before = checkCommandCodePricing([modelId], [row], localCosts, Date.parse(expires) - 1)
    assert.deepEqual(before.issues, [])
    const at = checkCommandCodePricing([modelId], [row], localCosts, Date.parse(expires))
    assert.deepEqual(
      at.issues.map((issue) => issue.kind),
      ["expired-deal"],
    )
  })

  it("lists an undated deal without inventing an expiration", () => {
    const result = checkCommandCodePricing(
      [modelId],
      [dealRow(undefined, "while capacity lasts")],
      localCosts,
      AT_MS,
    )
    assert.deepEqual(result.issues, [])
    assert.equal(result.deals[0]!.deal.endsWhen, "while capacity lasts")
    assert.equal(result.deals[0]!.deal.expires, undefined)
  })

  it("uses the literal discounted rates instead of listRates or discountPercent", () => {
    const rows = parsePricingPage(
      pageWithRows([
        {
          id: modelId,
          tiers: [{ rates: { input: 1, output: 2 }, listRates: { input: 9, output: 9 } }],
          deal: { id: "d", discountPercent: 90, free: false },
        },
      ]),
    )
    assert.deepEqual(ratesJson(rows[0]!.cost), { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
  })

  it("rejects an impossible calendar date", () => {
    assert.throws(
      () =>
        parsePricingPage(
          pageWithRows([
            {
              id: "m",
              tiers: [{ rates: { input: 1, output: 1 } }],
              deal: { id: "d", discountPercent: 1, free: false, expires: "2026-02-30" },
            },
          ]),
        ),
      /valid calendar date/,
    )
  })

  it("reports the real Qwen 3.7 Max expired deal even when rates match", () => {
    const rows = parsePricingPage(fixtureHtml)
    const row = findRow(rows, "qwen-3.7-max")
    const result = checkCommandCodePricing(
      ["Qwen/Qwen3.7-Max"],
      rows,
      { "Qwen/Qwen3.7-Max": row.cost },
      Date.UTC(2026, 9, 5, 12, 0, 0),
    )
    assert.deepEqual(
      result.issues.map((issue) => issue.kind),
      ["expired-deal"],
    )
  })
})

describe("runner and report", () => {
  it("checks the API and pricing routes without authorization headers", async () => {
    const { impl, calls } = fakeFetch({
      models: modelsBody(["m"]),
      page: pageWithRows([{ id: "m", tiers: [{ rates: { input: 1, output: 2 } }] }]),
    })
    await runPricingCheck({ fetchImpl: impl, atMs: AT_MS, localCosts: { m: cost(1, 2, 0, 0) } })
    assert.deepEqual(
      calls.map((call) => call.url),
      [DEFAULT_MODELS_URL, PRICING_SOURCE_URL],
    )
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string> | undefined
      assert.equal(headers?.authorization, undefined)
      assert.equal(headers?.Authorization, undefined)
    }
  })

  it("returns CLI code 2 for HTTP failures and network rejections", async () => {
    const pageFail = fakeFetch({ models: modelsBody(["m"]), pageStatus: 503 })
    const pageOut = await captureCli(pageFail.impl, {})
    assert.equal(pageOut.code, 2)
    assert.match(pageOut.stdout, /ERROR/)

    const reject = (async () => {
      throw new Error("network down")
    }) as typeof fetch
    const netOut = await captureCli(reject, {})
    assert.equal(netOut.code, 2)
    assert.match(netOut.stdout, /ERROR/)

    const badApi = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === DEFAULT_MODELS_URL) {
        return new Response(JSON.stringify({ object: "wrong" }), { status: 200 })
      }
      return new Response("", { status: 200 })
    }) as typeof fetch
    const badOut = await captureCli(badApi, {})
    assert.equal(badOut.code, 2)
    assert.match(badOut.stdout, /ERROR/)
  })

  it("rejects unknown CLI arguments without fetching", async () => {
    let calls = 0
    const impl = (async () => {
      calls += 1
      throw new Error("should not fetch")
    }) as typeof fetch
    let stderr = ""
    const code = await runPricingCheckCli({
      args: ["--write"],
      fetchImpl: impl,
      stdout: () => {},
      stderr: (text) => {
        stderr += text
      },
    })
    assert.equal(code, 2)
    assert.equal(calls, 0)
    assert.match(stderr, /Usage/)
  })

  it("renders deterministic reports and escapes table cells", () => {
    const result = {
      checkedModelCount: 1,
      issues: [{ kind: "changed-cost" as const, modelId: "m", detail: "a|b\nc\\|d\\" }],
      unusedPageIds: [],
      deals: [],
    }
    const report = renderPricingReport(result)
    assert.match(report, /REVIEW REQUIRED/)
    assert.ok(report.includes("a\\|b c\\\\\\|d\\\\"))
    assert.equal(report, renderPricingReport(result))
  })

  it("renders PASS and no drift for a clean result", () => {
    const report = renderPricingReport({
      checkedModelCount: 1,
      issues: [],
      unusedPageIds: ["informational"],
      deals: [],
    })
    assert.match(report, /PASS/)
    assert.match(report, /No pricing drift detected\./)
    assert.doesNotMatch(report, /REVIEW REQUIRED/)
  })

  it("does not fetch or change process.exitCode on import", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      throw new Error("unexpected fetch")
    }) as typeof fetch
    try {
      const exitCodeBefore = process.exitCode
      const moduleUrl = new URL(
        "../.github/scripts/check-commandcode-pricing.ts?import-side-effect-check",
        import.meta.url,
      )
      await import(moduleUrl.href)
      assert.equal(calls, 0)
      assert.equal(process.exitCode, exitCodeBefore)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
