/**
 * Unit tests for the Oh My Pi usage-provider integration (src/usage.ts).
 *
 * Hermetic: no host runtime and no network. The provider is driven through the
 * real quota fetch with a mocked `fetchImpl`, so the HTTP payload, the
 * credential plumb-through, and the report mapping are covered together.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { CommandCodeQuota } from "../src/quota-types.ts"
import { createCommandCodeUsageProvider, quotaToUsageReport } from "../src/usage.ts"

interface Handler {
  body: unknown
  status?: number
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function mockQuotaFetch(handlers: Record<string, Handler>) {
  const requests: Array<{ url: string; authorization: string | null; zdr: string | null }> = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    const url = String(input)
    requests.push({
      url,
      authorization: headers.get("authorization"),
      zdr: headers.get("x-cmd-zdr"),
    })
    for (const [needle, handler] of Object.entries(handlers)) {
      if (url.includes(needle)) return jsonResponse(handler.body, handler.status ?? 200)
    }
    throw new Error(`Unexpected URL: ${url}`)
  }
  return { fetchImpl: fetchImpl as typeof fetch, requests }
}

const WHOAMI = {
  user: { userName: "alice", keyName: "Pi Agent" },
  org: { id: "org_1", login: "alice-inc" },
}

const FULL_SNAPSHOT: Record<string, Handler> = {
  whoami: { body: WHOAMI },
  credits: {
    body: {
      credits: { monthlyCredits: 40, purchasedCredits: 10, freeCredits: 5 },
      windowLimits: {
        fiveHour: { used: 8, cap: 16, resetAt: 1_700_000_000_000 },
        weekly: { used: 20, cap: 40, resetAt: null },
      },
    },
  },
  subscriptions: {
    body: {
      data: {
        planId: "individual-go",
        status: "active",
        currentPeriodStart: "2026-01-01T00:00:00Z",
        currentPeriodEnd: "2026-02-01T00:00:00Z",
      },
    },
  },
  summary: { body: { totalCost: 12.34, totalCount: 1500, totalTokens: 74_200_000 } },
}

function provider(
  overrides: { headers?: Record<string, string>; getConfiguredKey?: () => string | undefined } = {},
) {
  return createCommandCodeUsageProvider({
    apiBase: "https://api.commandcode.ai",
    ...overrides,
  })
}

describe("Command Code OMP usage provider", () => {
  it("maps the full quota snapshot onto the host report", async () => {
    const { fetchImpl, requests } = mockQuotaFetch(FULL_SNAPSHOT)
    const usage = await provider({ headers: { "x-cmd-zdr": "1" } }).fetchUsage(
      { provider: "commandcode", credential: { type: "api_key", apiKey: "cc_test_key" } },
      { fetch: fetchImpl },
    )

    assert.ok(usage)
    // The host keys the override by provider name; a different id would leave
    // the account without a usage provider again.
    assert.equal(usage.provider, "commandcode")
    assert.equal(provider().id, "commandcode")
    assert.deepEqual(usage.limits, [
      {
        id: "5h",
        label: "5 Hour",
        scope: {
          provider: "commandcode",
          accountId: "alice-inc",
          orgId: "org_1",
          windowId: "5h",
        },
        window: {
          id: "5h",
          label: "5 Hour",
          durationMs: 5 * 60 * 60 * 1000,
          resetsAt: 1_700_000_000_000,
        },
        amount: { used: 8, limit: 16, unit: "unknown", usedFraction: 0.5, remainingFraction: 0.5 },
      },
      {
        id: "7d",
        label: "Weekly",
        scope: {
          provider: "commandcode",
          accountId: "alice-inc",
          orgId: "org_1",
          windowId: "7d",
        },
        window: { id: "7d", label: "Weekly", durationMs: 7 * 24 * 60 * 60 * 1000 },
        amount: { used: 20, limit: 40, unit: "unknown", usedFraction: 0.5, remainingFraction: 0.5 },
      },
      {
        id: "credits",
        label: "Credits",
        scope: { provider: "commandcode", accountId: "alice-inc", orgId: "org_1" },
        amount: {
          unit: "usd",
          remaining: 55,
          used: 12.34,
          limit: 67.34,
          usedFraction: 12.34 / 67.34,
          remainingFraction: 1 - 12.34 / 67.34,
        },
      },
    ])
    assert.equal(usage.notes, undefined)
    // metadata.orgId stays unset: OMP reads it as an org gate and would list
    // every org-less stored credential as an account without usage data.
    assert.deepEqual(usage.metadata, {
      accountId: "alice-inc",
      planType: "individual-go",
      planStatus: "active",
    })

    assert.equal(requests.length, 4)
    for (const request of requests) {
      assert.match(request.url, /^https:\/\/api\.commandcode\.ai\/alpha\//)
      assert.equal(request.authorization, "Bearer cc_test_key")
      assert.equal(request.zdr, "1")
    }
  })

  it("reports unavailable sections instead of fabricating zero usage", async () => {
    const { fetchImpl } = mockQuotaFetch({
      whoami: { body: WHOAMI },
      credits: { body: { error: "boom" }, status: 500 },
      subscriptions: { body: { error: "boom" }, status: 500 },
      summary: { body: { totalCost: 3, totalCount: 10 } },
    })
    const usage = await provider().fetchUsage(
      { provider: "commandcode", credential: { type: "api_key", apiKey: "cc_test_key" } },
      { fetch: fetchImpl },
    )

    assert.ok(usage)
    // Credits carry every window row, so a failed credits endpoint yields no
    // limits at all — never zero-valued ones.
    assert.deepEqual(usage.limits, [])
    assert.deepEqual(usage.notes, [
      "Credits unavailable from Command Code",
      "Plan unavailable from Command Code",
    ])
    assert.equal("planType" in (usage.metadata ?? {}), false)
    assert.equal("planStatus" in (usage.metadata ?? {}), false)
  })

  it("keeps the credit pool out of the report until the spend is known", async () => {
    const { fetchImpl } = mockQuotaFetch({
      whoami: { body: WHOAMI },
      credits: { body: { credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 } } },
      subscriptions: { body: { data: { planId: "individual-go" } } },
      summary: { body: { error: "boom" }, status: 500 },
    })
    const usage = await provider().fetchUsage(
      { provider: "commandcode", credential: { type: "api_key", apiKey: "cc_test_key" } },
      { fetch: fetchImpl },
    )

    assert.ok(usage)
    assert.deepEqual(usage.limits, [
      {
        id: "credits",
        label: "Credits",
        scope: { provider: "commandcode", accountId: "alice-inc", orgId: "org_1" },
        amount: { unit: "usd", remaining: 5 },
      },
    ])
    assert.deepEqual(usage.notes, ["Usage summary unavailable from Command Code"])
  })

  it("returns no report when every section is unavailable", async () => {
    const { fetchImpl } = mockQuotaFetch({
      whoami: { body: WHOAMI },
      credits: { body: { changed: "schema" } },
      subscriptions: { body: { changed: "schema" } },
      summary: { body: { changed: "schema" } },
    })
    const usage = await provider().fetchUsage(
      { provider: "commandcode", credential: { type: "api_key", apiKey: "cc_test_key" } },
      { fetch: fetchImpl },
    )

    assert.equal(usage, null)
  })

  it("returns no report when Command Code rejects the credential", async () => {
    const { fetchImpl } = mockQuotaFetch({
      whoami: { body: { error: "unauthorized" }, status: 401 },
    })
    const usage = await provider().fetchUsage(
      { provider: "commandcode", credential: { type: "api_key", apiKey: "cc_rejected" } },
      { fetch: fetchImpl },
    )

    assert.equal(usage, null)
  })

  it("uses the OAuth bearer, and a configured key for placeholder credentials", async () => {
    const oauth = mockQuotaFetch(FULL_SNAPSHOT)
    await provider().fetchUsage(
      { provider: "commandcode", credential: { type: "oauth", accessToken: "cc_oauth_token" } },
      { fetch: oauth.fetchImpl },
    )
    assert.equal(oauth.requests[0]?.authorization, "Bearer cc_oauth_token")

    const placeholder = mockQuotaFetch(FULL_SNAPSHOT)
    await provider({ getConfiguredKey: () => "cc_env_key" }).fetchUsage(
      { provider: "commandcode", credential: { type: "api_key", apiKey: "$COMMAND_CODE_API_KEY" } },
      { fetch: placeholder.fetchImpl },
    )
    assert.equal(placeholder.requests[0]?.authorization, "Bearer cc_env_key")
  })

  it("fetches nothing without a usable credential", async () => {
    const { fetchImpl, requests } = mockQuotaFetch(FULL_SNAPSHOT)
    const usage = await provider({ getConfiguredKey: () => undefined }).fetchUsage(
      { provider: "commandcode", credential: { type: "oauth" } },
      { fetch: fetchImpl },
    )

    assert.equal(usage, null)
    assert.deepEqual(requests, [])
  })

  it("omits reset times the API reports as absent", async () => {
    const { fetchImpl } = mockQuotaFetch({
      whoami: { body: WHOAMI },
      credits: {
        body: {
          credits: { monthlyCredits: 3.98 },
          // The live endpoint reports resetAt 0 for a window with no usage yet.
          windowLimits: { fiveHour: { used: 0, cap: 3, resetAt: 0 } },
        },
      },
      subscriptions: { body: { data: { planId: "individual-go" } } },
      summary: { body: { totalCost: 6.02, totalCount: 3386 } },
    })
    const usage = await provider().fetchUsage(
      { provider: "commandcode", credential: { type: "api_key", apiKey: "cc_test_key" } },
      { fetch: fetchImpl },
    )

    assert.ok(usage)
    assert.deepEqual(usage.limits[0], {
      id: "5h",
      label: "5 Hour",
      scope: { provider: "commandcode", accountId: "alice-inc", orgId: "org_1", windowId: "5h" },
      window: { id: "5h", label: "5 Hour", durationMs: 5 * 60 * 60 * 1000 },
      amount: { used: 0, limit: 3, unit: "unknown", usedFraction: 0, remainingFraction: 1 },
    })
    assert.deepEqual(usage.limits[1], {
      id: "credits",
      label: "Credits",
      scope: { provider: "commandcode", accountId: "alice-inc", orgId: "org_1" },
      amount: {
        unit: "usd",
        remaining: 3.98,
        used: 6.02,
        limit: 10,
        usedFraction: 6.02 / 10,
        remainingFraction: 1 - 6.02 / 10,
      },
    })
  })

  it("publishes the fractions text renderers read directly", () => {
    const quota: CommandCodeQuota = {
      account: { login: "aarisr", orgId: null },
      credits: {
        monthlyCredits: 3.98,
        purchasedCredits: 0,
        freeCredits: 0,
        remainingCredits: 3.98,
        windowLimits: [{ window: "fiveHour", used: 3, cap: 3, resetAt: null }],
      },
      subscription: null,
      summary: { totalCost: 6.02, totalCount: 3386 },
    }
    const report = quotaToUsageReport(quota, 1_700_000_000_000)

    // OMP's session/ACP `/usage` text renderer reads `amount.usedFraction`
    // without resolving `used`/`limit`, so a window that only carries the
    // reported pair renders as "0.00 used" with an empty bar.
    assert.deepEqual(
      report.limits.map((limit) => ({
        id: limit.id,
        usedFraction: limit.amount.usedFraction,
        remainingFraction: limit.amount.remainingFraction,
      })),
      [
        { id: "5h", usedFraction: 1, remainingFraction: 0 },
        { id: "credits", usedFraction: 6.02 / 10, remainingFraction: 1 - 6.02 / 10 },
      ],
    )
  })

  it("maps a report for an account without an organization", () => {
    const quota: CommandCodeQuota = {
      account: { login: "aarisr", orgId: null },
      credits: null,
      subscription: null,
      summary: null,
    }
    const report = quotaToUsageReport(quota, 1_700_000_000_000)

    assert.deepEqual(report, {
      provider: "commandcode",
      fetchedAt: 1_700_000_000_000,
      limits: [],
      metadata: { accountId: "aarisr" },
    })
  })
})
