import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { commandCodeCostRatesAt } from "../../src/cost.ts"
import {
  DEFAULT_MODELS_TIMEOUT_MS,
  DEFAULT_MODELS_URL,
  fetchCommandCodeModels,
} from "../../src/models.ts"
import {
  MODEL_COSTS,
  PRICING_LAST_VERIFIED,
  PRICING_SOURCE_URL,
  type CommandCodeModelCost,
  type CommandCodeModelCostRates,
  type CommandCodeModelCostTier,
} from "../../src/pricing.ts"

export interface PricingPageRow {
  id: string
  cost: CommandCodeModelCost
  timeOfDay?: {
    offPeak: CommandCodeModelCostRates
    peak: CommandCodeModelCostRates
    windows: string
    effective: string
  }
  deal?: {
    id: string
    discountPercent: number
    free: boolean
    expires?: string
    endsWhen?: string
  }
}

export interface PricingCheckIssue {
  kind:
    | "missing-local-price"
    | "missing-page-row"
    | "ambiguous-page-row"
    | "changed-cost"
    | "time-policy"
    | "expired-deal"
  modelId: string
  detail: string
}

export interface PricingCheckResult {
  checkedModelCount: number
  issues: readonly PricingCheckIssue[]
  unusedPageIds: readonly string[]
  // Promotions are visible even when there is no price drift.
  deals: readonly {
    modelId: string
    deal: NonNullable<PricingPageRow["deal"]>
    resolvedExpired?: boolean
  }[]
}

/**
 * Explicit page-row aliases keyed by the exact Provider API model id. The page
 * mostly uses basenames, so only the models whose page id cannot be derived
 * from the API id need an entry here.
 */
const PRICING_PAGE_ID_ALIASES: Readonly<Record<string, string>> = {
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  "Qwen/Qwen3.6-Max-Preview": "qwen-3.6-max",
  "nvidia/nemotron-3-ultra-550b-a55b": "nemotron-3-ultra",
}

/** DeepSeek V4 documents peak pricing in these two weekday windows. */
const SUPPORTED_TIME_WINDOWS = "01–04 & 06–10 UTC, Mon–Fri"

/** First integer hour of the fixed probe week (2026-10-05 is a Monday). */
const PROBE_WEEK_START_MS = Date.UTC(2026, 9, 5, 0, 0, 0)
const PROBE_HOURS = 168
const RATE_TOLERANCE = 1e-12

const SCRIPT_TAG_RE = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi
const NEXT_PUSH_RE = /^self\.__next_f\.push\(([\s\S]*)\);?$/
const FLIGHT_RECORD_RE = /^[0-9a-fA-F]+:([\s\S]*)$/
const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/
const SINGLE_CONTEXT_RE = /^≤\s*(\d+)K$/
const ABOVE_CONTEXT_RE = /^>\s*(\d+)K$/

interface NormalizedCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tiers: readonly CommandCodeModelCostTier[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Expected ${label} to be an object`)
  return value
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${label} to be a non-empty string`)
  }
  return value
}

function requireFiniteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Expected ${label} to be a finite non-negative number`)
  }
  return value
}

function requirePositiveBand(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected ${label} to be a positive integer band`)
  }
  return parsed * 1000
}

function requireIsoTimestamp(value: unknown, label: string): string {
  const text = requireNonEmptyString(value, label)
  const match = ISO_TIMESTAMP_RE.exec(text)
  if (!match) throw new Error(`Expected ${label} to be a UTC ISO timestamp with Z`)
  const [, year, month, day, hour, minute, second, fraction] = match
  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number((fraction ?? "0").slice(0, 3).padEnd(3, "0")),
    ),
  )
  const valid =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second)
  if (!valid) throw new Error(`Expected ${label} to be a valid UTC ISO timestamp with Z`)
  return text
}

function requireExpires(value: unknown, label: string): string {
  const text = requireNonEmptyString(value, label)
  const calendar = CALENDAR_DATE_RE.exec(text)
  if (calendar) {
    const [, year, month, day] = calendar
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
    const valid =
      date.getUTCFullYear() === Number(year) &&
      date.getUTCMonth() === Number(month) - 1 &&
      date.getUTCDate() === Number(day)
    if (!valid) throw new Error(`Expected ${label} to be a valid calendar date`)
    return text
  }
  return requireIsoTimestamp(text, label)
}

function parseRates(value: unknown, label: string): CommandCodeModelCostRates {
  const record = requireRecord(value, `${label} rates`)
  return {
    input: requireFiniteNonNegative(record.input, `${label} input`),
    output: requireFiniteNonNegative(record.output, `${label} output`),
    cacheRead:
      record.cacheRead === undefined
        ? 0
        : requireFiniteNonNegative(record.cacheRead, `${label} cacheRead`),
    cacheWrite:
      record.cacheWrite === undefined
        ? 0
        : requireFiniteNonNegative(record.cacheWrite, `${label} cacheWrite`),
  }
}

function ratesEqual(left: CommandCodeModelCostRates, right: CommandCodeModelCostRates): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite
  )
}

function ratesClose(left: CommandCodeModelCostRates, right: CommandCodeModelCostRates): boolean {
  return (
    Math.abs(left.input - right.input) <= RATE_TOLERANCE &&
    Math.abs(left.output - right.output) <= RATE_TOLERANCE &&
    Math.abs(left.cacheRead - right.cacheRead) <= RATE_TOLERANCE &&
    Math.abs(left.cacheWrite - right.cacheWrite) <= RATE_TOLERANCE
  )
}

function parseTiers(
  value: unknown,
  label: string,
): { base: CommandCodeModelCostRates; tiers: CommandCodeModelCostTier[] } {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Expected ${label} to have a non-empty tiers array`)
  }
  const parsed = value.map((tier, index) => {
    const record = requireRecord(tier, `${label} tier ${index}`)
    return {
      context: record.context,
      rates: parseRates(record.rates, `${label} tier ${index}`),
    }
  })

  if (parsed.length === 1) {
    const context = parsed[0]!.context
    if (context !== undefined) {
      const match = SINGLE_CONTEXT_RE.exec(String(context))
      if (!match) throw new Error(`Unsupported context band for ${label}: ${String(context)}`)
      requirePositiveBand(match[1]!, `${label} band ${context}`)
    }
    return { base: parsed[0]!.rates, tiers: [] }
  }

  const upperBounds: number[] = []
  for (let index = 0; index < parsed.length; index += 1) {
    const context = parsed[index]!.context
    if (typeof context !== "string") {
      throw new Error(`Expected ${label} tier ${index} to have a context band`)
    }
    const isLast = index === parsed.length - 1
    if (isLast) {
      const match = ABOVE_CONTEXT_RE.exec(context)
      if (!match) throw new Error(`Expected the last ${label} tier to be a '> NK' band: ${context}`)
      const above = Number(match[1]) * 1000
      if (!Number.isInteger(above) || above <= 0) {
        throw new Error(`Expected ${label} band ${context} to be a positive integer`)
      }
      if (upperBounds[upperBounds.length - 1] !== above) {
        throw new Error(`Expected the last ${label} tier '${context}' to match the previous band`)
      }
    } else {
      const match = SINGLE_CONTEXT_RE.exec(context)
      if (!match) {
        throw new Error(`Expected ${label} tier ${index} to be a '≤ NK' band: ${context}`)
      }
      const bound = requirePositiveBand(match[1]!, `${label} band ${context}`)
      if (upperBounds.length > 0 && bound <= upperBounds[upperBounds.length - 1]!) {
        throw new Error(`Expected ${label} context bands to strictly increase`)
      }
      upperBounds.push(bound)
    }
  }

  const base = parsed[0]!.rates
  const tiers: CommandCodeModelCostTier[] = []
  let previous = base
  for (let index = 1; index < parsed.length; index += 1) {
    const rates = parsed[index]!.rates
    if (ratesEqual(rates, previous)) continue
    tiers.push({ inputTokensAbove: upperBounds[index - 1]!, ...rates })
    previous = rates
  }
  return { base, tiers }
}

function parseRow(value: unknown, index: number): PricingPageRow {
  const record = requireRecord(value, `pricing row ${index}`)
  const id = requireNonEmptyString(record.id, `pricing row ${index} id`)
  const label = `pricing row ${id}`
  const { base, tiers } = parseTiers(record.tiers, label)
  const cost: CommandCodeModelCost = { ...base, ...(tiers.length > 0 ? { tiers } : {}) }

  let timeOfDay: PricingPageRow["timeOfDay"]
  if (record.timeOfDay !== undefined) {
    const parsed = requireRecord(record.timeOfDay, `${label} timeOfDay`)
    const offPeak = parseRates(parsed.offPeak, `${label} offPeak`)
    const peak = parseRates(parsed.peak, `${label} peak`)
    const windows = requireNonEmptyString(parsed.windows, `${label} windows`)
    const effective = requireIsoTimestamp(parsed.effective, `${label} effective`)
    if (!ratesEqual(offPeak, base)) {
      throw new Error(`Expected ${label} off-peak rates to match the base table rates`)
    }
    timeOfDay = { offPeak, peak, windows, effective }
  }

  let deal: PricingPageRow["deal"]
  if (record.deal !== undefined) {
    const parsed = requireRecord(record.deal, `${label} deal`)
    const dealId = requireNonEmptyString(parsed.id, `${label} deal id`)
    const discountPercent = requireFiniteNonNegative(
      parsed.discountPercent,
      `${label} discountPercent`,
    )
    if (discountPercent > 100) {
      throw new Error(`Expected ${label} discountPercent to be at most 100`)
    }
    if (typeof parsed.free !== "boolean") {
      throw new Error(`Expected ${label} deal free to be a boolean`)
    }
    const endsWhen =
      parsed.endsWhen === undefined
        ? undefined
        : requireNonEmptyString(parsed.endsWhen, `${label} endsWhen`)
    const expires =
      parsed.expires === undefined ? undefined : requireExpires(parsed.expires, `${label} expires`)
    deal = {
      id: dealId,
      discountPercent,
      free: parsed.free,
      ...(expires !== undefined ? { expires } : {}),
      ...(endsWhen !== undefined ? { endsWhen } : {}),
    }
  }

  return { id, cost, ...(timeOfDay ? { timeOfDay } : {}), ...(deal ? { deal } : {}) }
}

/**
 * Extract the normalized pricing table from Command Code's Next.js Flight
 * payload. This depends on the private page format, not on a public pricing
 * API, so an unrecognized shape is an error rather than an empty success.
 */
export function parsePricingPage(html: string): readonly PricingPageRow[] {
  const chunks: string[] = []
  for (const match of html.matchAll(SCRIPT_TAG_RE)) {
    const body = (match[1] ?? "").trim()
    const push = NEXT_PUSH_RE.exec(body)
    if (!push) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(push[1]!)
    } catch {
      continue
    }
    if (Array.isArray(parsed) && parsed[0] === 1 && typeof parsed[1] === "string") {
      chunks.push(parsed[1])
    }
  }

  const flight = chunks.join("")
  const rowsPayloads: unknown[][] = []
  for (const line of flight.split("\n")) {
    const record = FLIGHT_RECORD_RE.exec(line)
    if (!record) continue
    const suffix = record[1]!
    if (!suffix.startsWith("[")) continue
    let value: unknown
    try {
      value = JSON.parse(suffix)
    } catch {
      if (suffix.includes('"rows"')) throw new Error("Malformed pricing page rows record")
      continue
    }
    if (
      Array.isArray(value) &&
      value.length >= 4 &&
      isRecord(value[3]) &&
      Object.prototype.hasOwnProperty.call(value[3], "rows")
    ) {
      rowsPayloads.push((value[3] as { rows: unknown[] }).rows)
    }
  }

  if (rowsPayloads.length !== 1) {
    throw new Error(`Expected exactly one pricing rows payload, found ${rowsPayloads.length}`)
  }
  const rows = rowsPayloads[0]!
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Expected the pricing rows payload to be a non-empty array")
  }

  const parsedRows = rows.map((row, index) => parseRow(row, index))
  const seen = new Set<string>()
  for (const row of parsedRows) {
    const key = row.id.toLowerCase()
    if (seen.has(key)) throw new Error(`Duplicate pricing row id: ${row.id}`)
    seen.add(key)
  }
  return parsedRows
}

export function pricingPageIdCandidates(modelId: string): readonly string[] {
  const candidates = new Set<string>()
  candidates.add(modelId.toLowerCase())
  const alias = PRICING_PAGE_ID_ALIASES[modelId]
  if (alias !== undefined) {
    candidates.add(alias)
  } else {
    const basename = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase()
    candidates.add(basename.replace(/^qwen(?=\d)/, "qwen-"))
  }
  return [...candidates]
}

function requireLocalRate(value: unknown, modelId: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Expected ${modelId} ${field} to be a finite non-negative number`)
  }
  return value
}

function normalizeLocalCost(cost: CommandCodeModelCost, modelId: string): NormalizedCost {
  const rates = {
    input: requireLocalRate(cost.input, modelId, "input"),
    output: requireLocalRate(cost.output, modelId, "output"),
    cacheRead: requireLocalRate(cost.cacheRead, modelId, "cacheRead"),
    cacheWrite: requireLocalRate(cost.cacheWrite, modelId, "cacheWrite"),
  }
  const tiers: CommandCodeModelCostTier[] = []
  let previousThreshold = -1
  let previousRates = rates
  for (const tier of cost.tiers ?? []) {
    const tierRates = {
      input: requireLocalRate(tier.input, modelId, "tier input"),
      output: requireLocalRate(tier.output, modelId, "tier output"),
      cacheRead: requireLocalRate(tier.cacheRead, modelId, "tier cacheRead"),
      cacheWrite: requireLocalRate(tier.cacheWrite, modelId, "tier cacheWrite"),
    }
    if (!Number.isInteger(tier.inputTokensAbove) || tier.inputTokensAbove <= 0) {
      throw new Error(`Expected ${modelId} tier inputTokensAbove to be a positive integer`)
    }
    if (tier.inputTokensAbove <= previousThreshold) {
      throw new Error(`Expected ${modelId} tier thresholds to strictly increase`)
    }
    previousThreshold = tier.inputTokensAbove
    if (ratesEqual(tierRates, previousRates)) continue
    tiers.push({ inputTokensAbove: tier.inputTokensAbove, ...tierRates })
    previousRates = tierRates
  }
  return { ...rates, tiers }
}

function normalizeCost(cost: CommandCodeModelCost): NormalizedCost {
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    tiers: cost.tiers ?? [],
  }
}

function tiersEqual(
  left: readonly CommandCodeModelCostTier[],
  right: readonly CommandCodeModelCostTier[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((tier, index) => {
    const other = right[index]!
    return tier.inputTokensAbove === other.inputTokensAbove && ratesEqual(tier, other)
  })
}

function normalizedCostsEqual(left: NormalizedCost, right: NormalizedCost): boolean {
  return ratesEqual(left, right) && tiersEqual(left.tiers, right.tiers)
}

function costJson(cost: NormalizedCost): Record<string, unknown> {
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    tiers: cost.tiers.map((tier) => ({
      inputTokensAbove: tier.inputTokensAbove,
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cacheRead,
      cacheWrite: tier.cacheWrite,
    })),
  }
}

function dealExpiryMs(deal: NonNullable<PricingPageRow["deal"]>): number | undefined {
  if (deal.expires === undefined) return undefined
  const calendar = CALENDAR_DATE_RE.exec(deal.expires)
  if (calendar) {
    const [, year, month, day] = calendar
    // The deal covers the whole calendar day, so it expires at the next UTC midnight.
    return Date.UTC(Number(year), Number(month) - 1, Number(day) + 1)
  }
  return Date.parse(deal.expires)
}

function isPeakProbe(atMs: number): boolean {
  const date = new Date(atMs)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

function checkTimePolicy(
  modelId: string,
  pageRow: PricingPageRow,
  atMs: number,
): PricingCheckIssue | undefined {
  const baseRates: CommandCodeModelCostRates = {
    input: pageRow.cost.input,
    output: pageRow.cost.output,
    cacheRead: pageRow.cost.cacheRead,
    cacheWrite: pageRow.cost.cacheWrite,
  }
  let expected: (probeMs: number) => CommandCodeModelCostRates = () => baseRates
  const timeOfDay = pageRow.timeOfDay
  if (timeOfDay) {
    if (timeOfDay.windows !== SUPPORTED_TIME_WINDOWS) {
      return {
        kind: "time-policy",
        modelId,
        detail: `Unsupported time-pricing window requires review: ${timeOfDay.windows}`,
      }
    }
    if (Date.parse(timeOfDay.effective) > atMs) {
      return {
        kind: "time-policy",
        modelId,
        detail: `Future effective date requires review: ${timeOfDay.effective}`,
      }
    }
    expected = (probeMs) => (isPeakProbe(probeMs) ? timeOfDay.peak : timeOfDay.offPeak)
  }

  for (let hour = 0; hour < PROBE_HOURS; hour += 1) {
    const probeMs = PROBE_WEEK_START_MS + hour * 3_600_000
    const actual = commandCodeCostRatesAt(modelId, pageRow.cost, probeMs)
    const want = expected(probeMs)
    if (!ratesClose(actual, want)) {
      return {
        kind: "time-policy",
        modelId,
        detail: `First mismatch at ${new Date(probeMs).toISOString()}: current=${JSON.stringify(
          actual,
        )} expected=${JSON.stringify(want)}`,
      }
    }
  }
  return undefined
}

export function checkCommandCodePricing(
  modelIds: readonly string[],
  pageRows: readonly PricingPageRow[],
  localCosts: Readonly<Record<string, CommandCodeModelCost>>,
  atMs: number,
): PricingCheckResult {
  if (modelIds.length === 0) throw new Error("Expected at least one model id")
  const unique = new Set<string>()
  for (const modelId of modelIds) {
    if (typeof modelId !== "string" || modelId.length === 0) {
      throw new Error("Expected model ids to be non-empty strings")
    }
    if (unique.has(modelId)) throw new Error(`Duplicate model id: ${modelId}`)
    unique.add(modelId)
  }
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) {
    throw new Error("Expected atMs to be a finite timestamp")
  }

  const sortedModelIds = [...modelIds].sort()
  const matchedByModel = new Map<string, readonly PricingPageRow[]>()
  const claimCount = new Map<PricingPageRow, number>()
  for (const modelId of sortedModelIds) {
    const candidates = new Set(pricingPageIdCandidates(modelId))
    const matches = pageRows.filter((row) => candidates.has(row.id.toLowerCase()))
    matchedByModel.set(modelId, matches)
    for (const row of matches) claimCount.set(row, (claimCount.get(row) ?? 0) + 1)
  }

  const issues: PricingCheckIssue[] = []
  const deals: {
    modelId: string
    deal: NonNullable<PricingPageRow["deal"]>
    resolvedExpired?: boolean
  }[] = []

  for (const modelId of sortedModelIds) {
    const hasLocal = Object.prototype.hasOwnProperty.call(localCosts, modelId)
    if (!hasLocal) {
      issues.push({
        kind: "missing-local-price",
        modelId,
        detail: "No MODEL_COSTS entry for this advertised model.",
      })
    }

    const matches = matchedByModel.get(modelId) ?? []
    if (matches.length === 0) {
      issues.push({
        kind: "missing-page-row",
        modelId,
        detail: "No pricing page row matches this model id.",
      })
      continue
    }
    if (matches.length > 1) {
      issues.push({
        kind: "ambiguous-page-row",
        modelId,
        detail: `Matched ${matches.length} page rows: ${matches.map((row) => row.id).join(", ")}`,
      })
      continue
    }
    const pageRow = matches[0]!
    if ((claimCount.get(pageRow) ?? 0) > 1) {
      issues.push({
        kind: "ambiguous-page-row",
        modelId,
        detail: `Page row ${pageRow.id} is also claimed by another model id.`,
      })
      continue
    }

    if (pageRow.deal) {
      const expiry = dealExpiryMs(pageRow.deal)
      // Reviewed on 2026-10-06: the page retains this expired badge; its table rates remain current.
      const resolvedExpired =
        expiry !== undefined &&
        atMs >= expiry &&
        modelId === "Qwen/Qwen3.7-Max" &&
        pageRow.deal.id === "qwen-3.7-max-2x-usage" &&
        pageRow.deal.expires === "2026-06-22" &&
        pageRow.deal.discountPercent === 50 &&
        pageRow.deal.free === false &&
        pageRow.deal.endsWhen === undefined
      deals.push({ modelId, deal: pageRow.deal, ...(resolvedExpired ? { resolvedExpired } : {}) })
      if (expiry !== undefined && atMs >= expiry && !resolvedExpired) {
        issues.push({
          kind: "expired-deal",
          modelId,
          detail: `Deal ${pageRow.deal.id} expired at ${new Date(expiry).toISOString()}.`,
        })
      }
    }

    if (hasLocal) {
      const local = normalizeLocalCost(localCosts[modelId]!, modelId)
      const upstream = normalizeCost(pageRow.cost)
      if (!normalizedCostsEqual(local, upstream)) {
        issues.push({
          kind: "changed-cost",
          modelId,
          detail: `current=${JSON.stringify(costJson(local))} upstream=${JSON.stringify(
            costJson(upstream),
          )}`,
        })
      }
    }

    const timeIssue = checkTimePolicy(modelId, pageRow, atMs)
    if (timeIssue) issues.push(timeIssue)
  }

  const unusedPageIds = [
    ...new Set(pageRows.filter((row) => !claimCount.has(row)).map((row) => row.id)),
  ].sort()
  issues.sort((left, right) => {
    if (left.modelId !== right.modelId) return left.modelId < right.modelId ? -1 : 1
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1
    return 0
  })

  return { checkedModelCount: modelIds.length, issues, unusedPageIds, deals }
}

function formatId(value: string): string {
  return `\`${value.replace(/`/g, "")}\``
}

function formatCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .replace(/`/g, "")
}

export function renderPricingReport(result: PricingCheckResult): string {
  const status = result.issues.length === 0 ? "PASS" : "REVIEW REQUIRED"
  const lines: string[] = [
    "# Command Code pricing check",
    "",
    `- Pricing source: ${PRICING_SOURCE_URL}`,
    `- Model catalog: ${DEFAULT_MODELS_URL}`,
    `- Static snapshot verified: ${PRICING_LAST_VERIFIED}`,
    `- Models checked: ${result.checkedModelCount}`,
    "",
    `**Status: ${status}**`,
    "",
  ]

  if (result.issues.length === 0) {
    lines.push("No pricing drift detected.", "")
  } else {
    lines.push("| Kind | Model | Detail |", "| --- | --- | --- |")
    for (const issue of result.issues) {
      lines.push(
        `| ${formatCell(issue.kind)} | ${formatId(issue.modelId)} | ${formatCell(issue.detail)} |`,
      )
    }
    lines.push("")
  }

  lines.push("## Promotions", "")
  if (result.deals.length === 0) {
    lines.push("_No promotions reported._", "")
  } else {
    lines.push(
      "| Model | Deal | Discount | Free | Expires | Ends when | Review |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    )
    for (const { modelId, deal, resolvedExpired } of result.deals) {
      lines.push(
        `| ${formatId(modelId)} | ${formatId(deal.id)} | ${deal.discountPercent}% | ${
          deal.free ? "yes" : "no"
        } | ${deal.expires ? formatCell(deal.expires) : "—"} | ${
          deal.endsWhen ? formatCell(deal.endsWhen) : "—"
        } | ${resolvedExpired ? "Reviewed expired deal" : "—"} |`,
      )
    }
    lines.push("")
  }

  lines.push(
    "## Unused pricing-page rows",
    "",
    "Informational only: these site rows do not match an advertised API model.",
    "",
  )
  if (result.unusedPageIds.length === 0) {
    lines.push("_None._", "")
  } else {
    for (const id of result.unusedPageIds) lines.push(`- ${formatId(id)}`)
    lines.push("")
  }

  lines.push(
    "---",
    "",
    "Static prices in `src/pricing.ts` are unchanged by this check. The Command Code billing Usage page remains authoritative for each request, and every drift listed above requires manual review before prices are edited.",
    "",
  )
  return lines.join("\n")
}

function renderPricingFailure(message: string): string {
  return [
    "# Command Code pricing check",
    "",
    `- Pricing source: ${PRICING_SOURCE_URL}`,
    `- Model catalog: ${DEFAULT_MODELS_URL}`,
    "",
    "**ERROR: the pricing check could not be completed.**",
    "",
    `> ${formatCell(message)}`,
    "",
  ].join("\n")
}

export async function runPricingCheck(
  options: {
    fetchImpl?: typeof fetch
    atMs?: number
    localCosts?: Readonly<Record<string, CommandCodeModelCost>>
  } = {},
): Promise<PricingCheckResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const atMs = options.atMs ?? Date.now()
  const localCosts = options.localCosts ?? MODEL_COSTS

  const models = await fetchCommandCodeModels({ fetchImpl, timeoutMs: DEFAULT_MODELS_TIMEOUT_MS })
  const modelIds = models.map((model) => model.id)
  const seen = new Set<string>()
  for (const modelId of modelIds) {
    if (seen.has(modelId)) {
      throw new Error(`Duplicate model id in the Command Code catalog: ${modelId}`)
    }
    seen.add(modelId)
  }

  const response = await fetchImpl(PRICING_SOURCE_URL, {
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(DEFAULT_MODELS_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(
      `Failed to fetch the Command Code pricing page: ${response.status} ${response.statusText}`,
    )
  }
  const pageRows = parsePricingPage(await response.text())
  return checkCommandCodePricing(modelIds, pageRows, localCosts, atMs)
}

export async function runPricingCheckCli(options: {
  args: readonly string[]
  fetchImpl?: typeof fetch
  atMs?: number
  localCosts?: Readonly<Record<string, CommandCodeModelCost>>
  stdout: (text: string) => void
  stderr: (text: string) => void
}): Promise<0 | 1 | 2> {
  if (options.args.length > 0) {
    options.stderr("Usage: npm run check:commandcode-pricing\n")
    return 2
  }
  try {
    const result = await runPricingCheck({
      fetchImpl: options.fetchImpl,
      atMs: options.atMs,
      localCosts: options.localCosts,
    })
    options.stdout(renderPricingReport(result))
    return result.issues.length > 0 ? 1 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.stdout(renderPricingFailure(message))
    options.stderr(`${message}\n`)
    return 2
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1]
  return entrypoint !== undefined && pathToFileURL(resolve(entrypoint)).href === import.meta.url
}

if (isMainModule()) {
  process.exitCode = await runPricingCheckCli({
    args: process.argv.slice(2),
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
  })
}
