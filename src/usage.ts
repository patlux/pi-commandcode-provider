/**
 * Oh My Pi usage-provider integration.
 *
 * `pi.registerProvider(name, config)` accepts an optional `usage` field whose
 * `fetchUsage` returns a normalized report; the host then caches it, records
 * usage history, and renders it in its usage surfaces. pi itself has no such
 * field and ignores it, so the host types are mirrored structurally here — the
 * same approach src/quota-command.ts takes for the command context it is handed
 * — instead of depending on one host's package.
 *
 * Reports come from the existing quota layer. `fetchCommandCodeQuota` already
 * authenticates and parses the alpha endpoints `/commandcode-quota` uses, so
 * this module only maps that snapshot onto the host's schema.
 */

import { getConfiguredApiKey } from "./api-key.ts"
import { pickCommandCodeApiKey } from "./converters.ts"
import { fetchCommandCodeQuota } from "./quota.ts"
import type {
  CommandCodeQuota,
  CommandCodeQuotaSection,
  CommandCodeWindowLimit,
} from "./quota-types.ts"

export const COMMAND_CODE_PROVIDER = "commandcode"

/** OMP usage units (`@oh-my-pi/pi-ai`). */
export type UsageUnit = "percent" | "tokens" | "requests" | "usd" | "minutes" | "bytes" | "unknown"

export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown"

/** Quantitative usage data. Absent fields stay absent; they are never zero-filled. */
export interface UsageAmount {
  used?: number
  limit?: number
  remaining?: number
  usedFraction?: number
  remainingFraction?: number
  unit: UsageUnit
}

/** Time window for a limit, e.g. the 5-hour or weekly Command Code window. */
export interface UsageWindow {
  id: string
  label: string
  durationMs?: number
  /** Absolute reset time in milliseconds since epoch. */
  resetsAt?: number
  resetLabel?: string
}

/** Scope metadata describing what a limit applies to. */
export interface UsageScope {
  provider: string
  accountId?: string
  orgId?: string
  windowId?: string
}

/** One normalized limit row. */
export interface UsageLimit {
  id: string
  label: string
  scope: UsageScope
  window?: UsageWindow
  amount: UsageAmount
  status?: UsageStatus
  notes?: string[]
}

/** Normalized per-account usage report rendered by the host. */
export interface UsageReport {
  provider: string
  fetchedAt: number
  limits: UsageLimit[]
  notes?: string[]
  metadata?: Record<string, string>
}

/** Credential bundle the host normalizes for usage fetchers. */
export interface UsageCredential {
  type: "api_key" | "oauth"
  /** Present for stored API-key credentials, already resolved by the host. */
  apiKey?: string
  /** Present for OAuth credentials; Command Code's login returns its key here. */
  accessToken?: string
}

export interface UsageFetchParams {
  provider: string
  credential: UsageCredential
}

export interface UsageFetchContext {
  fetch: typeof fetch
}

/** Provider implementation for fetching usage information. */
export interface UsageProvider {
  id: string
  fetchUsage(params: UsageFetchParams, context: UsageFetchContext): Promise<UsageReport | null>
}

const WINDOW_META: Record<
  CommandCodeWindowLimit["window"],
  { id: string; label: string; durationMs: number }
> = {
  fiveHour: { id: "5h", label: "5 Hour", durationMs: 5 * 60 * 60 * 1000 },
  weekly: { id: "7d", label: "Weekly", durationMs: 7 * 24 * 60 * 60 * 1000 },
}

const SECTION_LABELS: Record<CommandCodeQuotaSection, string> = {
  credits: "Credits",
  subscription: "Plan",
  usage: "Usage summary",
}

/**
 * Add the used/remaining fractions OMP's renderers read directly.
 *
 * The dashboard resolves them from `used`/`limit`, but the session and ACP
 * `/usage` text renderer reads `amount.usedFraction` as-is, so a limit that
 * only carries the reported pair renders as a bare "0.00 used". Built-in usage
 * providers populate both, so this does too, clamping like they do.
 */
function withFractions(
  amount: UsageAmount,
  used: number | undefined,
  limit: number | undefined,
): UsageAmount {
  if (used === undefined || limit === undefined || limit <= 0) return amount
  const usedFraction = Math.min(Math.max(used / limit, 0), 1)
  return { ...amount, usedFraction, remainingFraction: 1 - usedFraction }
}

/**
 * Map a quota snapshot onto the host's report schema.
 *
 * Every window and credit figure the API reports is passed through unchanged;
 * sections the API did not report are listed in `notes` and left out of the
 * limits instead of being rendered as zero usage.
 */
export function quotaToUsageReport(
  quota: CommandCodeQuota,
  fetchedAt: number = Date.now(),
): UsageReport {
  const scope: UsageScope = {
    provider: COMMAND_CODE_PROVIDER,
    accountId: quota.account.login,
    ...(quota.account.orgId ? { orgId: quota.account.orgId } : {}),
  }
  const limits: UsageLimit[] = []

  for (const window of quota.credits?.windowLimits ?? []) {
    const meta = WINDOW_META[window.window]
    limits.push({
      id: meta.id,
      label: meta.label,
      scope: { ...scope, windowId: meta.id },
      window: {
        id: meta.id,
        label: meta.label,
        durationMs: meta.durationMs,
        ...(window.resetAt !== null && window.resetAt > 0
          ? { resetsAt: window.resetAt * 1000 }
          : {}),
      },
      // Command Code reports these windows as credit amounts and its own
      // `/usage` meter shows a percentage, so the unit stays unknown rather
      // than claiming tokens or dollars.
      amount: withFractions(
        { used: window.used, limit: window.cap, unit: "unknown" },
        window.used,
        window.cap,
      ),
    })
  }

  const credits = quota.credits
  if (credits) {
    const spent = quota.summary?.totalCost
    limits.push({
      id: "credits",
      label: "Credits",
      scope,
      // The pool is only known when the billing-period spend is: remaining plus
      // spent, the same total `/commandcode-quota` prints. Without it the row
      // reports what is left and claims no fraction of an unknown pool.
      amount: withFractions(
        {
          unit: "usd",
          remaining: credits.remainingCredits,
          ...(spent === undefined ? {} : { used: spent, limit: credits.remainingCredits + spent }),
        },
        spent,
        spent === undefined ? undefined : credits.remainingCredits + spent,
      ),
    })
  }

  const notes = (quota.unavailable ?? []).map(
    (section) => `${SECTION_LABELS[section]} unavailable from Command Code`,
  )

  return {
    provider: COMMAND_CODE_PROVIDER,
    fetchedAt,
    limits,
    ...(notes.length > 0 ? { notes } : {}),
    metadata: {
      accountId: quota.account.login,
      ...(quota.subscription?.planId ? { planType: quota.subscription.planId } : {}),
      ...(quota.subscription?.status ? { planStatus: quota.subscription.status } : {}),
    },
  }
}

export interface CreateCommandCodeUsageProviderOptions {
  /** Base URL of the Command Code alpha usage endpoints (no `/provider/v1` suffix). */
  apiBase: string
  /** Extra request headers, e.g. the ZDR flag, matching `/commandcode-quota`. */
  headers?: Record<string, string>
  getConfiguredKey?: () => string | undefined
  fetchQuota?: typeof fetchCommandCodeQuota
}

/**
 * Build the usage provider registered alongside the Command Code models.
 *
 * The host resolves an API-key credential before calling and exposes an OAuth
 * credential's bearer as `accessToken`; either way the key is resolved through
 * the same placeholder-aware helper `/commandcode-quota` uses.
 */
export function createCommandCodeUsageProvider(
  options: CreateCommandCodeUsageProviderOptions,
): UsageProvider {
  const getConfiguredKey = options.getConfiguredKey ?? getConfiguredApiKey
  const fetchQuota = options.fetchQuota ?? fetchCommandCodeQuota

  return {
    id: COMMAND_CODE_PROVIDER,
    async fetchUsage(params, context) {
      const apiKey = pickCommandCodeApiKey(
        params.credential.apiKey ?? params.credential.accessToken,
        getConfiguredKey(),
      )
      if (!apiKey) return null

      const result = await fetchQuota({
        apiKey,
        baseUrl: options.apiBase,
        fetchImpl: context?.fetch,
        extraHeaders: options.headers,
      })
      // A rejected key, an unreachable endpoint, or a changed schema is not
      // usage data: the host reports the account as having none.
      if (!result.ok) return null
      return quotaToUsageReport(result.quota)
    },
  }
}
