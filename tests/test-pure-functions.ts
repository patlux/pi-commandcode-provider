/** Hermetic tests for shared credential selection and error redaction. */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import {
  getConfiguredApiKey as getApiKey,
  pickCommandCodeApiKey,
  withResolvedCommandCodeApiKey,
} from "../src/api-key.ts"
import { redactCommandCodeErrorText } from "../src/overflow.ts"

describe("getApiKey()", () => {
  it("uses the official API key env var before the legacy alias", () => {
    assert.equal(
      getApiKey({
        env: { COMMAND_CODE_API_KEY: "official-key", COMMANDCODE_API_KEY: "legacy-key" },
        authPaths: [],
      }),
      "official-key",
    )
    assert.equal(
      getApiKey({ env: { COMMANDCODE_API_KEY: "legacy-key" }, authPaths: [] }),
      "legacy-key",
    )
  })

  it("reads apiKey, commandcode, pi OAuth, and official CLI credential fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-auth-"))
    try {
      const first = join(dir, "first.json")
      const second = join(dir, "second.json")
      const oauth = join(dir, "oauth.json")
      const official = join(dir, "official.json")
      writeFileSync(first, JSON.stringify({ apiKey: "file-key" }))
      writeFileSync(second, JSON.stringify({ commandcode: "fallback-key" }))
      writeFileSync(
        oauth,
        JSON.stringify({
          commandcode: {
            type: "oauth",
            access: "oauth-access-key",
            refresh: "oauth-refresh-key",
            expires: Date.now() + 3600000,
          },
        }),
      )
      writeFileSync(
        official,
        JSON.stringify({
          "command-code": {
            type: "api",
            key: "official-cli-key",
          },
        }),
      )
      assert.equal(getApiKey({ env: {}, authPaths: [first, second] }), "file-key")
      assert.equal(getApiKey({ env: {}, authPaths: [second] }), "fallback-key")
      assert.equal(getApiKey({ env: {}, authPaths: [oauth] }), "oauth-access-key")
      assert.equal(getApiKey({ env: {}, authPaths: [official] }), "official-cli-key")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ignores malformed auth files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-auth-bad-"))
    try {
      const bad = join(dir, "bad.json")
      writeFileSync(bad, "not json")
      assert.equal(getApiKey({ env: {}, authPaths: [bad] }), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("uses injected homeDir for default auth paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-home-"))
    try {
      const authDir = join(dir, ".pi", "agent")
      mkdirSync(authDir, { recursive: true })
      writeFileSync(join(authDir, "auth.json"), JSON.stringify({ commandcode: "pi-key" }))
      assert.equal(getApiKey({ env: {}, homeDir: () => dir }), "pi-key")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("error redaction", () => {
  it("redacts bearer, credential, and query-string secrets", () => {
    const redacted = redactCommandCodeErrorText(
      "Bearer user_secret_value api_key=user_secret_value https://example.test/x?token=user_secret_value",
    )
    assert.doesNotMatch(redacted, /user_secret_value/)
    assert.match(redacted, /Bearer \[redacted\]/)
    assert.doesNotMatch(
      redactCommandCodeErrorText("provider returned sk-test-secret-value-1234567890"),
      /sk-test-secret-value/,
    )
  })
})

describe("pickCommandCodeApiKey()", () => {
  it("falls back to the host key for a placeholder registry value", () => {
    assert.equal(pickCommandCodeApiKey("$COMMAND_CODE_API_KEY", "file-key"), "file-key")
    assert.equal(pickCommandCodeApiKey("COMMAND_CODE_API_KEY", "file-key"), "file-key")
    assert.equal(pickCommandCodeApiKey("$COMMANDCODE_API_KEY", "file-key"), "file-key")
    assert.equal(pickCommandCodeApiKey("COMMANDCODE_API_KEY", "file-key"), "file-key")
  })

  it("returns undefined when only a placeholder is provided (no fallback)", () => {
    assert.equal(pickCommandCodeApiKey("$COMMAND_CODE_API_KEY", undefined), undefined)
    assert.equal(pickCommandCodeApiKey("$COMMANDCODE_API_KEY", undefined), undefined)
  })

  it("prefers a real registry key over the host fallback", () => {
    assert.equal(pickCommandCodeApiKey("real-registry-key", "file-key"), "real-registry-key")
  })

  it("falls back to the host key when the registry has none", () => {
    assert.equal(pickCommandCodeApiKey(undefined, "file-key"), "file-key")
    assert.equal(pickCommandCodeApiKey(undefined, undefined), undefined)
  })

  it("falls back to the host key for empty or whitespace registry values", () => {
    assert.equal(pickCommandCodeApiKey("", "file-key"), "file-key")
    assert.equal(pickCommandCodeApiKey("   ", "file-key"), "file-key")
    assert.equal(pickCommandCodeApiKey(" ", undefined), undefined)
  })

  it("trims a real registry key", () => {
    assert.equal(pickCommandCodeApiKey("  real-registry-key  ", "file-key"), "real-registry-key")
  })

  it("never returns a placeholder as the host fallback", () => {
    assert.equal(pickCommandCodeApiKey(undefined, "$COMMAND_CODE_API_KEY"), undefined)
    assert.equal(pickCommandCodeApiKey("$COMMAND_CODE_API_KEY", "$COMMANDCODE_API_KEY"), undefined)
    assert.equal(pickCommandCodeApiKey("COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"), undefined)
  })

  it("omits a placeholder from registerProvider when no real key is configured", () => {
    assert.equal(pickCommandCodeApiKey(undefined, undefined), undefined)
    assert.equal(pickCommandCodeApiKey("$COMMAND_CODE_API_KEY", undefined), undefined)
    assert.equal(pickCommandCodeApiKey("user_real-key", undefined), "user_real-key")
  })
})

describe("withResolvedCommandCodeApiKey()", () => {
  it("replaces a host placeholder with the configured key", () => {
    assert.deepEqual(
      withResolvedCommandCodeApiKey({ apiKey: "$COMMAND_CODE_API_KEY", extra: true }, "file-key"),
      { apiKey: "file-key", extra: true },
    )
  })

  it("drops a placeholder when no configured key exists", () => {
    assert.deepEqual(
      withResolvedCommandCodeApiKey({ apiKey: "$COMMAND_CODE_API_KEY" }, undefined),
      {
        apiKey: undefined,
      },
    )
  })

  it("keeps a real host key and injects a configured key when the host omitted one", () => {
    const options = { apiKey: "host-key" }
    assert.equal(withResolvedCommandCodeApiKey(options, "file-key"), options)
    assert.deepEqual(withResolvedCommandCodeApiKey(undefined, "file-key"), { apiKey: "file-key" })
  })
})
