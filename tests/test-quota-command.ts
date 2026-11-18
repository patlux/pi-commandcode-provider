import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { registerCommandCodeQuota, type QuotaCommandContext } from "../src/quota-command.ts"
import type { CommandCodeQuotaResult } from "../src/quota-types.ts"

class CommandApiDouble {
  handler?: (args: string, ctx: QuotaCommandContext) => Promise<void>

  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: QuotaCommandContext) => Promise<void>
    },
  ): void {
    assert.equal(name, "commandcode-quota")
    assert.match(options.description, /usage and quota/)
    this.handler = options.handler
  }
}

function context(registryKey: string | undefined) {
  const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = []
  let waited = false
  const value = {
    async waitForIdle() {
      waited = true
    },
    modelRegistry: {
      async getApiKeyForProvider(provider: string) {
        assert.equal(provider, "commandcode")
        return registryKey
      },
    },
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type })
      },
    },
  } satisfies QuotaCommandContext
  return { value, notifications, waited: () => waited }
}

const quotaResult: CommandCodeQuotaResult = {
  ok: true,
  quota: {
    account: { login: "alice", orgId: null },
    credits: null,
    subscription: null,
    summary: { totalCost: 1, totalCount: 2 },
  },
}

describe("commandcode-quota command", () => {
  it("registers the command and resolves OMP placeholders through the fallback key", async () => {
    const pi = new CommandApiDouble()
    let requestKey = ""
    let requestBase = ""
    registerCommandCodeQuota(pi, {
      apiBase: "https://api.commandcode.ai",
      getConfiguredKey: () => "fallback-key",
      fetchQuota: async (options) => {
        requestKey = options.apiKey
        requestBase = options.baseUrl ?? ""
        return quotaResult
      },
    })

    assert.ok(pi.handler)
    const ctx = context("$COMMAND_CODE_API_KEY")
    await pi.handler("", ctx.value)
    assert.equal(ctx.waited(), true)
    assert.equal(requestKey, "fallback-key")
    assert.equal(requestBase, "https://api.commandcode.ai")
    assert.equal(ctx.notifications.at(-1)?.type, "info")
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Requests: 2/)
  })

  it("resolves headers at run time so a later change is sent", async () => {
    const pi = new CommandApiDouble()
    let headers: Record<string, string> | undefined
    const seen: Array<Record<string, string> | undefined> = []
    registerCommandCodeQuota(pi, {
      apiBase: "https://api.commandcode.ai",
      headers: () => headers,
      getConfiguredKey: () => "key",
      fetchQuota: async (options) => {
        seen.push(options.extraHeaders)
        return quotaResult
      },
    })

    assert.ok(pi.handler)
    await pi.handler("", context(undefined).value)
    headers = { "x-cmd-zdr": "1" }
    await pi.handler("", context(undefined).value)
    assert.deepEqual(seen, [undefined, { "x-cmd-zdr": "1" }])
  })

  it("warns without calling the endpoint when no API key is available", async () => {
    const pi = new CommandApiDouble()
    let called = false
    registerCommandCodeQuota(pi, {
      apiBase: "https://api.commandcode.ai",
      getConfiguredKey: () => undefined,
      fetchQuota: async () => {
        called = true
        return quotaResult
      },
    })

    assert.ok(pi.handler)
    const ctx = context(undefined)
    await pi.handler("", ctx.value)
    assert.equal(called, false)
    assert.equal(ctx.notifications.at(-1)?.type, "warning")
    assert.match(ctx.notifications.at(-1)?.message ?? "", /requires an API key/)
  })

  it("redacts endpoint failures before notifying the host", async () => {
    const pi = new CommandApiDouble()
    registerCommandCodeQuota(pi, {
      apiBase: "https://api.commandcode.ai",
      getConfiguredKey: () => "real-key",
      fetchQuota: async () => ({
        ok: false,
        error: { kind: "http", message: "api_key=supersecretvalue123456 failed" },
      }),
    })

    assert.ok(pi.handler)
    const ctx = context("real-key")
    await pi.handler("", ctx.value)
    assert.equal(ctx.notifications.at(-1)?.type, "error")
    assert.doesNotMatch(ctx.notifications.at(-1)?.message ?? "", /supersecret/)
  })
})
