/**
 * Tests for the Command Code OAuth / browser auth flow.
 *
 * Tests the local callback server (src/auth-server.ts) and the OAuth
 * integration functions (src/oauth.ts).
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { startAuthServer, type AuthCallback } from "../src/auth-server.ts"
import {
  getApiKey,
  login,
  refreshToken,
  sanitizeApiKey,
  validateApiKey,
  validationApiBase,
} from "../src/oauth.ts"

/**
 * Helper: wait for an HTTP server to close, or resolve immediately if already closed.
 */
function waitForClose(server: {
  listening: boolean
  on(event: "close", cb: () => void): void
}): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve(undefined)
    server.on("close", resolve)
  })
}

async function withValidApiKeyFetch<T>(run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    if (String(input).endsWith("/alpha/whoami")) {
      return Promise.resolve(new Response(JSON.stringify({ user: {} }), { status: 200 }))
    }
    return originalFetch(input, init)
  }
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe("startAuthServer()", () => {
  it("starts on a localhost port and accepts a valid callback POST", async () => {
    const { server, port, waitForCallback } = await startAuthServer({
      startPort: 0,
      expectedState: "test-state-token",
    })

    const callbackData: AuthCallback = {
      apiKey: "user_testKey123",
      state: "test-state-token",
      userId: "user_123",
      userName: "Test User",
      keyName: "test-key",
    }

    // Simulate the Command Code Studio posting the API key back
    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify(callbackData),
    })

    assert.equal(response.status, 200)
    const body = (await response.json()) as { success: boolean }
    assert.equal(body.success, true)

    const result = await waitForCallback
    assert.equal(result.apiKey, "user_testKey123")
    assert.equal(result.state, "test-state-token")
    assert.equal(result.userId, "user_123")
    assert.equal(result.userName, "Test User")
    assert.equal(result.keyName, "test-key")

    await waitForClose(server)
  })

  it("rejects a mismatched state without closing the callback server", async () => {
    const { server, port, waitForCallback } = await startAuthServer({
      startPort: 0,
      expectedState: "correct-state",
    })

    const invalidResponse = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify({
        apiKey: "user_badState",
        state: "wrong-state",
        userId: "user_789",
        userName: "Attacker",
        keyName: "evil-key",
      }),
    })
    assert.equal(invalidResponse.status, 403)
    assert.equal(server.listening, true)

    const validResponse = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify({
        apiKey: "user_valid",
        state: "correct-state",
        userId: "user_123",
        userName: "Valid User",
        keyName: "valid-key",
      }),
    })
    assert.equal(validResponse.status, 200)
    assert.equal((await waitForCallback).apiKey, "user_valid")
    await waitForClose(server)
  })

  it("rejects untrusted browser origins before handling callback errors", async () => {
    const { server, port, waitForCallback } = await startAuthServer({
      startPort: 0,
      expectedState: "trusted-state",
    })

    // text/plain avoids preflight, so CORS response headers alone cannot protect side effects.
    const rejected = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "https://untrusted.example" },
      body: JSON.stringify({ error: "access_denied", error_description: "forged cancellation" }),
    })
    assert.equal(rejected.status, 403)
    assert.equal(server.listening, true)

    const accepted = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify({
        apiKey: "user_legitimate",
        state: "trusted-state",
        userId: "user_123",
        userName: "Test User",
        keyName: "test-key",
      }),
    })
    assert.equal(accepted.status, 200)
    assert.equal((await waitForCallback).apiKey, "user_legitimate")
    await waitForClose(server)
  })

  it("ignores callback errors that do not carry the state token", async () => {
    const { server, port, waitForCallback } = await startAuthServer({
      startPort: 0,
      expectedState: "trusted-state",
    })

    // A trusted origin (or an origin-less local client) must still prove it
    // received the state token before it can cancel the pending login.
    const missingState = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "access_denied", error_description: "forged cancellation" }),
    })
    assert.equal(missingState.status, 403)
    assert.equal(server.listening, true)

    const wrongState = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify({ error: "server_error", state: "wrong-state" }),
    })
    assert.equal(wrongState.status, 403)
    assert.equal(server.listening, true)

    const accepted = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify({
        apiKey: "user_legitimate",
        state: "trusted-state",
        userId: "user_123",
        userName: "Test User",
        keyName: "test-key",
      }),
    })
    assert.equal(accepted.status, 200)
    assert.equal((await waitForCallback).apiKey, "user_legitimate")
    await waitForClose(server)
  })

  it("honors callback errors that carry the state token", async () => {
    const { server, port, waitForCallback } = await startAuthServer({
      startPort: 0,
      expectedState: "trusted-state",
    })
    const errorPromise: Promise<string> = waitForCallback.then(
      () => {
        throw new Error("Expected callback to reject")
      },
      (e: Error) => e.message,
    )

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify({
        error: "access_denied",
        error_description: "User cancelled",
        state: "trusted-state",
      }),
    })
    assert.equal(response.status, 200)
    assert.match(await errorPromise, /User cancelled/)
    await waitForClose(server)
  })

  it("rejects the local development origin", async () => {
    const { server, port } = await startAuthServer({ startPort: 0, expectedState: "s" })
    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "http://localhost:3000" },
      body: JSON.stringify({ error: "access_denied", state: "s" }),
    })
    assert.equal(response.status, 403)
    assert.equal(server.listening, true)
    server.close()
  })

  it("rejects untrusted browser preflights", async () => {
    const { server, port } = await startAuthServer({ startPort: 0 })
    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://untrusted.example",
        "Access-Control-Request-Headers": "content-type",
      },
    })
    assert.equal(response.status, 403)
    server.close()
  })

  it("rejects when the callback indicates access_denied", async () => {
    const { server, port, waitForCallback } = await startAuthServer({ startPort: 0 })

    // Attach rejection handler before posting to avoid unhandled rejection
    const errorPromise: Promise<string> = waitForCallback.then(
      () => {
        throw new Error("Expected callback to reject")
      },
      (e: Error) => e.message,
    )

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify({ error: "access_denied", error_description: "User cancelled" }),
    })

    assert.equal(response.status, 200)

    const errorMsg = await errorPromise
    assert.match(errorMsg, /User cancelled/)

    await waitForClose(server)
  })

  it("returns 400 for missing required fields", async () => {
    const { server, port } = await startAuthServer({ startPort: 0 })

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify({ apiKey: "key", state: "s" }),
    })

    assert.equal(response.status, 400)

    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()
  })

  it("handles CORS and private-network preflight OPTIONS request", async () => {
    const { server, port } = await startAuthServer({ startPort: 0 })

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://commandcode.ai",
        "Access-Control-Request-Headers": "content-type,x-requested-with",
        "Access-Control-Request-Private-Network": "true",
      },
    })

    assert.equal(response.status, 204)
    assert.equal(response.headers.get("access-control-allow-origin"), "https://commandcode.ai")
    assert.equal(
      response.headers.get("access-control-allow-headers"),
      "content-type,x-requested-with",
    )
    assert.equal(response.headers.get("access-control-allow-private-network"), "true")

    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()
  })

  it("returns 404 for non-callback paths", async () => {
    const { server, port } = await startAuthServer({ startPort: 0 })

    const response = await fetch(`http://127.0.0.1:${port}/other`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })

    assert.equal(response.status, 404)

    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()
  })

  it("returns 405 for GET on /callback", async () => {
    const { server, port } = await startAuthServer({ startPort: 0 })

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "GET",
      headers: { Origin: "https://commandcode.ai" },
    })

    assert.equal(response.status, 405)

    await new Promise((resolve) => setTimeout(resolve, 100))
    server.close()
  })
})

describe("OAuth functions", () => {
  it("getApiKey returns the access token", () => {
    const creds = {
      refresh: "refresh-key",
      access: "access-key",
      expires: Date.now() + 3600000,
    }
    assert.equal(getApiKey(creds), "access-key")
  })

  it("refreshToken returns updated far-future expiry", async () => {
    const creds = {
      refresh: "my-api-key",
      access: "my-api-key",
      expires: Date.now() - 1000, // already expired
    }
    const result = await refreshToken(creds)
    assert.equal(result.access, "my-api-key")
    assert.equal(result.refresh, "my-api-key")
    assert.ok(result.expires > Date.now(), "expiry should be in the future")
  })

  it("sanitizeApiKey removes paste markers, control chars, and whitespace", () => {
    assert.equal(sanitizeApiKey("\u001b[200~  user_manualKey\n\u001b[201~"), "user_manualKey")
  })

  it("validates manual API keys through whoami", async () => {
    await validateApiKey("valid-key", {
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ user: {} }), { status: 200 })),
    })
    await assert.rejects(
      validateApiKey("invalid-key", {
        fetchImpl: () => Promise.resolve(new Response("unauthorized", { status: 401 })),
      }),
      /Invalid Command Code API key/,
    )
  })

  it("validates against the configured API base like the chat transports", async () => {
    assert.equal(validationApiBase({}), "https://api.commandcode.ai")
    assert.equal(
      validationApiBase({ COMMANDCODE_API_BASE: "http://127.0.0.1:4321/provider/v1" }),
      "http://127.0.0.1:4321",
    )
    assert.equal(
      validationApiBase({ COMMANDCODE_API_BASE: "http://127.0.0.1:4321/provider/v1/" }),
      "http://127.0.0.1:4321",
    )

    const originalBase = process.env.COMMANDCODE_API_BASE
    process.env.COMMANDCODE_API_BASE = "http://127.0.0.1:4321/provider/v1"
    try {
      let requestedUrl = ""
      await validateApiKey("valid-key", {
        fetchImpl: (input) => {
          requestedUrl = String(input)
          return Promise.resolve(new Response(JSON.stringify({ user: {} }), { status: 200 }))
        },
      })
      assert.equal(requestedUrl, "http://127.0.0.1:4321/alpha/whoami")
    } finally {
      if (originalBase === undefined) delete process.env.COMMANDCODE_API_BASE
      else process.env.COMMANDCODE_API_BASE = originalBase
    }
  })

  it("times out a stalled whoami request even when fetch ignores the signal", async () => {
    const started = Date.now()
    await assert.rejects(
      validateApiKey("stalled-key", {
        timeoutMs: 20,
        fetchImpl: () => new Promise<Response>(() => {}),
      }),
      /Could not validate the Command Code API key: request timed out after 20ms/,
    )
    assert.ok(Date.now() - started < 1_000)
  })

  it("reports the timeout when fetch honors the abort signal", async () => {
    let aborted = false
    await assert.rejects(
      validateApiKey("stalled-key", {
        timeoutMs: 20,
        fetchImpl: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true
              reject(init.signal?.reason)
            })
          }),
      }),
      /request timed out after 20ms/,
    )
    assert.equal(aborted, true)
  })
})

describe("login()", () => {
  it("completes the full browser login flow via the local server", async () => {
    let authUrl = ""
    const callbacks = {
      onAuth(params: { url: string }) {
        authUrl = params.url
      },
      onPrompt(_params: { message: string }): Promise<string> {
        return Promise.resolve("")
      },
    }

    // Start login in the background
    const loginPromise = login(callbacks)

    // Wait for onAuth to be called (it fires asynchronously after the auth server starts)
    while (!authUrl) await new Promise((resolve) => setTimeout(resolve, 10))

    // Verify the auth URL was passed to callbacks (callback URL is encoded)
    assert.match(
      authUrl,
      /^https:\/\/commandcode\.ai\/studio\/auth\/cli\?callback=http%3A%2F%2Flocalhost%3A\d+%2Fcallback&state=/,
    )

    // Extract port and state from the URL
    const url = new URL(authUrl)
    const port = parseInt(url.searchParams.get("callback")?.match(/localhost:(\d+)/)?.[1] ?? "0")
    const state = url.searchParams.get("state") ?? ""

    assert.ok(port > 0, "auth server should be on a non-zero port")
    assert.ok(state.length > 0, "state token should not be empty")

    // Simulate the Command Code Studio posting the API key back
    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://commandcode.ai",
      },
      body: JSON.stringify({
        apiKey: "user_browserApiKey",
        state,
        userId: "user_456",
        userName: "Browser User",
        keyName: "browser-key",
      }),
    })

    assert.equal(response.status, 200)

    const result = await loginPromise
    assert.equal(result.access, "user_browserApiKey")
    assert.equal(result.refresh, "user_browserApiKey")
    assert.ok(result.expires > Date.now(), "expiry should be far in the future")
  })

  it("prompts for a manual API key if browser transfer times out", async () => {
    const originalTimeout = process.env.COMMANDCODE_AUTH_TIMEOUT_MS
    process.env.COMMANDCODE_AUTH_TIMEOUT_MS = "1"

    let authUrl = ""
    const promptMessages: string[] = []

    try {
      const result = await withValidApiKeyFetch(() =>
        login({
          onAuth(params: { url: string }) {
            authUrl = params.url
          },
          async onPrompt(params: { message: string }): Promise<string> {
            promptMessages.push(params.message)
            return promptMessages.length === 1 ? "" : "\u001b[200~  user_manualApiKey\n\u001b[201~"
          },
        }),
      )

      assert.match(authUrl, /^https:\/\/commandcode\.ai\/studio\/auth\/cli\?/)
      assert.match(promptMessages[1] ?? "", /Paste your Command Code API key/)
      assert.equal(result.access, "user_manualApiKey")
      assert.equal(result.refresh, "user_manualApiKey")
      assert.ok(result.expires > Date.now(), "expiry should be far in the future")
    } finally {
      if (originalTimeout === undefined) delete process.env.COMMANDCODE_AUTH_TIMEOUT_MS
      else process.env.COMMANDCODE_AUTH_TIMEOUT_MS = originalTimeout
    }
  })

  it("accepts a directly pasted API key", async () => {
    let authOpened = false
    const result = await withValidApiKeyFetch(() =>
      login({
        onAuth() {
          authOpened = true
        },
        onPrompt(): Promise<string> {
          return Promise.resolve("user_directApiKey")
        },
      }),
    )

    assert.equal(authOpened, false)
    assert.equal(result.access, "user_directApiKey")
  })

  it("offers an explicit API key prompt", async () => {
    let promptCount = 0
    const result = await withValidApiKeyFetch(() =>
      login({
        onAuth() {
          throw new Error("browser should not open")
        },
        onPrompt(): Promise<string> {
          promptCount += 1
          return Promise.resolve(promptCount === 1 ? "key" : "user_promptedApiKey")
        },
      }),
    )

    assert.equal(result.access, "user_promptedApiKey")
    assert.equal(promptCount, 2)
  })

  it("keeps waiting after a state mismatch and accepts the legitimate callback", async () => {
    let authUrl = ""
    const callbacks = {
      onAuth(params: { url: string }) {
        authUrl = params.url
      },
      onPrompt(_params: { message: string }): Promise<string> {
        return Promise.resolve("")
      },
    }

    const loginPromise = login(callbacks)

    // Wait for onAuth to be called asynchronously
    while (!authUrl) await new Promise((resolve) => setTimeout(resolve, 10))

    const url = new URL(authUrl)
    const port = parseInt(url.searchParams.get("callback")?.match(/localhost:(\d+)/)?.[1] ?? "0")

    // Post back with a wrong state token.
    const invalidResponse = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify({
        apiKey: "user_badState",
        state: "wrong-state-token",
        userId: "user_789",
        userName: "Attacker",
        keyName: "evil-key",
      }),
    })

    assert.equal(invalidResponse.status, 403)

    const validResponse = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://commandcode.ai" },
      body: JSON.stringify({
        apiKey: "user_goodState",
        state: url.searchParams.get("state"),
        userId: "user_123",
        userName: "Real User",
        keyName: "real-key",
      }),
    })
    assert.equal(validResponse.status, 200)
    assert.equal((await loginPromise).access, "user_goodState")
  })
})
