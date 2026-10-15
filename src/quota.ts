import { redactCommandCodeErrorText } from "./overflow.ts"
import type {
  CommandCodeCredits,
  CommandCodeQuotaResult,
  CommandCodeQuotaSection,
  CommandCodeSubscription,
  CommandCodeUsageSummary,
  CommandCodeWindowLimit,
} from "./quota-types.ts"

export const DEFAULT_API_BASE = "https://api.commandcode.ai"
export const QUOTA_TIMEOUT_MS = 15_000

interface FetchOptions {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  extraHeaders?: Record<string, string>
}

interface HttpErrorShape {
  __httpError: true
  message: string
  status: number
  body: string
}

interface QuotaErrorShape {
  __quotaError: true
  kind: "timeout" | "network"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function timestampValue(value: unknown): string | undefined {
  const text = stringValue(value)
  if (text) return text
  const number = numberValue(value)
  return number === undefined ? undefined : String(number)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeResetAt(value: unknown): number | null {
  let timestamp: number | undefined
  if (typeof value === "number" && Number.isFinite(value)) timestamp = value
  if (typeof value === "string" && value.length > 0) {
    const trimmed = value.trim()
    timestamp = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed)
  }
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp < 0) return null
  return timestamp >= 1e12 ? Math.round(timestamp / 1000) : timestamp
}

export function windowLimitsFromCredits(value: unknown): CommandCodeWindowLimit[] {
  if (!isRecord(value)) return []
  const limits: CommandCodeWindowLimit[] = []
  for (const [window, entry] of [
    ["fiveHour", value.fiveHour],
    ["weekly", value.weekly],
  ] as const) {
    if (!isRecord(entry)) continue
    const used = numberValue(entry.used)
    const cap = numberValue(entry.cap)
    if (used === undefined || cap === undefined || (used === 0 && cap === 0)) continue
    limits.push({ window, used, cap, resetAt: normalizeResetAt(entry.resetAt) })
  }
  return limits
}

function parseCredits(value: unknown): CommandCodeCredits | null {
  if (!isRecord(value) || !isRecord(value.credits)) return null
  const credits = value.credits
  const monthlyCredits = numberValue(credits.monthlyCredits)
  const purchasedCredits = numberValue(credits.purchasedCredits)
  const freeCredits = numberValue(credits.freeCredits)
  if (monthlyCredits === undefined && purchasedCredits === undefined && freeCredits === undefined) {
    return null
  }
  const monthly = monthlyCredits ?? 0
  const purchased = purchasedCredits ?? 0
  const free = freeCredits ?? 0
  return {
    monthlyCredits: monthly,
    purchasedCredits: purchased,
    freeCredits: free,
    remainingCredits: monthly + purchased + free,
    windowLimits: windowLimitsFromCredits(value.windowLimits),
  }
}

function parseSubscription(value: unknown): CommandCodeSubscription | null {
  if (!isRecord(value) || !isRecord(value.data)) return null
  const data = value.data
  const planId = stringValue(data.planId)
  const status = stringValue(data.status)
  const currentPeriodStart = timestampValue(data.currentPeriodStart)
  const currentPeriodEnd = timestampValue(data.currentPeriodEnd)
  if (!planId && !status && !currentPeriodStart && !currentPeriodEnd) return null
  return {
    planId: planId ?? null,
    status: status ?? null,
    currentPeriodStart: currentPeriodStart ?? null,
    currentPeriodEnd: currentPeriodEnd ?? null,
  }
}

function parseSummary(value: unknown): CommandCodeUsageSummary | null {
  if (!isRecord(value)) return null
  const totalCost = numberValue(value.totalCost)
  const totalCount = numberValue(value.totalCount)
  if (totalCost === undefined || totalCount === undefined) return null
  const totalTokens = numberValue(value.totalTokens) ?? numberValue(value.tokens)
  return { totalCost, totalCount, ...(totalTokens === undefined ? {} : { totalTokens }) }
}

function parseWhoami(value: unknown): {
  login: string
  orgId: string | null
  keyName?: string
} | null {
  if (!isRecord(value)) return null
  const org = isRecord(value.org) ? value.org : undefined
  const user = isRecord(value.user) ? value.user : undefined
  const login =
    (org ? stringValue(org.login) : undefined) ??
    (user ? (stringValue(user.userName) ?? stringValue(user.name)) : undefined)
  if (!login) return null
  const orgId = org ? stringValue(org.id) : undefined
  const keyName = user ? (stringValue(user.keyName) ?? stringValue(user.displayName)) : undefined
  return { login, orgId: orgId ?? null, ...(keyName ? { keyName } : {}) }
}

function buildUrl(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  const query = search.toString()
  return `${path}${query ? `?${query}` : ""}`
}

function isHttpError(value: unknown): value is HttpErrorShape {
  return (
    isRecord(value) &&
    value.__httpError === true &&
    typeof value.message === "string" &&
    typeof value.status === "number" &&
    typeof value.body === "string"
  )
}

function isQuotaError(value: unknown): value is QuotaErrorShape {
  return (
    isRecord(value) &&
    value.__quotaError === true &&
    (value.kind === "timeout" || value.kind === "network")
  )
}

function isBlockingHttpError(error: HttpErrorShape): boolean {
  return error.status === 401 || error.status === 403
}

function httpFailure(error: HttpErrorShape, context: string): CommandCodeQuotaResult {
  const detail = error.body.trim().slice(0, 200)
  return {
    ok: false,
    error: {
      kind: "http",
      message: redactValue(
        `${context} request failed (${error.status}): ${detail || error.message}`,
      ),
    },
  }
}

class QuotaTimeoutError extends Error {}

export async function fetchCommandCodeQuota(
  options: FetchOptions,
): Promise<CommandCodeQuotaResult> {
  if (!options.apiKey) {
    return { ok: false, error: { message: "No Command Code API key found", kind: "config" } }
  }

  const baseUrl = options.baseUrl ?? DEFAULT_API_BASE
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? QUOTA_TIMEOUT_MS
  const overallController = new AbortController()
  // AbortSignal is cooperative: a custom fetch or stalled response body may ignore it.
  // Race every I/O phase against a single deadline so /commandcode-quota always returns.
  let rejectDeadline: ((error: QuotaTimeoutError) => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const overallTimer = setTimeout(() => {
    overallController.abort()
    rejectDeadline?.(new QuotaTimeoutError())
  }, timeoutMs)

  function withinDeadline<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, deadline])
  }
  const headers = {
    accept: "application/json",
    Authorization: `Bearer ${options.apiKey}`,
    ...options.extraHeaders,
  }

  const request = async (path: string): Promise<unknown> => {
    if (overallController.signal.aborted) throw new QuotaTimeoutError()
    try {
      const response = await withinDeadline(
        fetchImpl(`${baseUrl}${path}`, {
          method: "GET",
          headers,
          signal: overallController.signal,
        }),
      )
      if (!response.ok) {
        return {
          __httpError: true,
          message:
            response.status === 401 || response.status === 403
              ? "Command Code rejected the API key"
              : response.statusText,
          status: response.status,
          body: await withinDeadline(response.text().catch(() => "")),
        } satisfies HttpErrorShape
      }
      return await withinDeadline(response.json())
    } catch (error) {
      if (overallController.signal.aborted) throw new QuotaTimeoutError()
      throw error
    }
  }

  const safeRequest = async (path: string): Promise<unknown> => {
    try {
      return await request(path)
    } catch (error) {
      return {
        __quotaError: true,
        kind: error instanceof QuotaTimeoutError ? "timeout" : "network",
      } satisfies QuotaErrorShape
    }
  }

  try {
    const whoamiRaw = await request("/alpha/whoami")
    if (isHttpError(whoamiRaw)) return httpFailure(whoamiRaw, "whoami")
    const account = parseWhoami(whoamiRaw)
    if (!account) {
      return {
        ok: false,
        error: { kind: "http", message: "Command Code returned an unrecognized account response" },
      }
    }

    const orgId = account.orgId ?? undefined
    const [creditsRaw, subscriptionRaw] = await Promise.all([
      safeRequest(buildUrl("/alpha/billing/credits", { orgId })),
      safeRequest(buildUrl("/alpha/billing/subscriptions", { orgId })),
    ])
    if (isHttpError(creditsRaw) && isBlockingHttpError(creditsRaw)) {
      return httpFailure(creditsRaw, "credits")
    }
    if (isHttpError(subscriptionRaw) && isBlockingHttpError(subscriptionRaw)) {
      return httpFailure(subscriptionRaw, "subscription")
    }

    const unavailable: CommandCodeQuotaSection[] = []
    const credits =
      isHttpError(creditsRaw) || isQuotaError(creditsRaw) ? null : parseCredits(creditsRaw)
    if (!credits) unavailable.push("credits")
    const subscription =
      isHttpError(subscriptionRaw) || isQuotaError(subscriptionRaw)
        ? null
        : parseSubscription(subscriptionRaw)
    if (!subscription) unavailable.push("subscription")

    const summaryRaw = await safeRequest(
      buildUrl("/alpha/usage/summary", {
        orgId,
        since: subscription?.currentPeriodStart ?? undefined,
      }),
    )
    if (isHttpError(summaryRaw) && isBlockingHttpError(summaryRaw)) {
      return httpFailure(summaryRaw, "summary")
    }
    const summary =
      isHttpError(summaryRaw) || isQuotaError(summaryRaw) ? null : parseSummary(summaryRaw)
    if (!summary) unavailable.push("usage")

    if (!credits && !subscription && !summary) {
      return {
        ok: false,
        error: {
          kind: overallController.signal.aborted ? "timeout" : "http",
          message: overallController.signal.aborted
            ? "Command Code quota request timed out"
            : "Command Code returned no recognized usage data for the account",
        },
      }
    }

    return {
      ok: true,
      quota: {
        account,
        credits,
        subscription,
        summary,
        ...(unavailable.length > 0 ? { unavailable } : {}),
      },
    }
  } catch (error) {
    if (error instanceof QuotaTimeoutError || overallController.signal.aborted) {
      return {
        ok: false,
        error: { message: "Command Code quota request timed out", kind: "timeout" },
      }
    }
    return {
      ok: false,
      error: {
        message: redactValue(`Failed to fetch Command Code quota: ${errorMessage(error)}`),
        kind: "network",
      },
    }
  } finally {
    clearTimeout(overallTimer)
  }
}

export function redactValue(value: string): string {
  return redactCommandCodeErrorText(value)
    .replace(
      /("\s*(?:api[-_ ]?key|apikey|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|authorization)\s*"\s*:\s*")([^"]{8,})/gi,
      "$1[redacted]",
    )
    .trim()
}
