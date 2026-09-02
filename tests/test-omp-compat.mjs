#!/usr/bin/env node
/**
 * OMP compatibility smoke test.
 *
 * Uses an isolated HOME/PI_CODING_AGENT_DIR so the test does not depend on or
 * mutate the user's real ~/.omp state. The Command Code API base is pointed at
 * a deterministic local mock server so print mode can exercise the provider
 * without touching the real API.
 */

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = resolve(__dirname, "..")
const EXT_PATH = resolve(PROJECT_DIR, "index.ts")
const ADVISORY_EXT_PATH = resolve(PROJECT_DIR, "tests/fixtures/advisory-injector-extension.ts")
const TEST_MODEL = "deepseek/deepseek-v4-flash"
const ADVISORY_XML =
  '<advisory severity="blocker" guidance="weigh, don\'t blindly obey">\nStop and correct the benchmark.\n</advisory>'

function findOmpBinary() {
  if (process.env.OMP_BIN) return process.env.OMP_BIN
  const candidates = (process.env.PATH ?? "").split(delimiter).map((entry) => resolve(entry, "omp"))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try next PATH entry.
    }
  }
  return undefined
}

const OMP_BIN = findOmpBinary()
if (!OMP_BIN) {
  if (process.env.OMP_COMPAT_REQUIRED === "1") {
    console.error("[omp-compat] FAIL - omp is required but not on PATH and OMP_BIN is unset")
    process.exit(1)
  }
  console.log("[omp-compat] SKIP - omp is not on PATH")
  process.exit(0)
}

const tempHome = mkdtempSync(join(tmpdir(), "omp-cc-home-"))
let requestCount = 0
let modelListRequestCount = 0
let lastRequestBody
let requestBodies = []
let lastRequestHeaders = {}
// When true the mock Provider API answers 403 upgrade_required so the
// transport router falls back to the legacy /alpha/generate transport.
let providerUpgradeRequired = false

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/provider/v1/models") {
    modelListRequestCount += 1
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: TEST_MODEL,
            object: "model",
            created: 1779824324,
            owned_by: "command-code",
            name: "DeepSeek V4 Flash",
            context_length: 1_000_000,
          },
          {
            id: "Qwen/Qwen3.7-Max",
            object: "model",
            created: 1779824324,
            owned_by: "command-code",
            name: "Qwen 3.7 Max",
            context_length: 1_000_000,
          },
        ],
      }),
    )
    return
  }

  if (req.method === "POST" && req.url === "/provider/v1/chat/completions") {
    requestCount += 1
    lastRequestHeaders = Object.fromEntries(
      Object.entries(req.headers).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.join(", ") : (value ?? ""),
      ]),
    )

    let body = ""
    req.on("data", (chunk) => {
      body += chunk.toString("utf-8")
    })
    req.on("end", () => {
      try {
        lastRequestBody = JSON.parse(body)
        requestBodies.push(lastRequestBody)
      } catch {
        lastRequestBody = undefined
      }

      if (providerUpgradeRequired) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" })
        res.end(JSON.stringify({ error: { code: "upgrade_required" } }))
        return
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Transfer-Encoding": "chunked",
      })
      res.write(
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "mock-omp-ok" }, finish_reason: null }] })}\n\n`,
      )
      res.write(
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      )
      res.write(
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      )
      res.end("data: [DONE]\n\n")
    })
    return
  }

  if (req.method !== "POST" || req.url !== "/alpha/generate") {
    res.writeHead(404)
    res.end("Not found")
    return
  }

  requestCount += 1
  lastRequestHeaders = Object.fromEntries(
    Object.entries(req.headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(", ") : (value ?? ""),
    ]),
  )

  let generateBody = ""
  req.on("data", (chunk) => {
    generateBody += chunk.toString("utf-8")
  })
  req.on("end", () => {
    try {
      lastRequestBody = JSON.parse(generateBody)
      requestBodies.push(lastRequestBody)
    } catch {
      lastRequestBody = undefined
    }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
    })
    res.write(`${JSON.stringify({ type: "text-delta", text: "mock-omp-ok" })}\n`)
    res.write(
      `${JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } })}\n`,
    )
    res.end()
  })
})

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
const port = typeof address === "object" && address ? address.port : 0
const apiBase = `http://127.0.0.1:${port}`

const agentDir = join(tempHome, ".omp", "agent")

function ompEnv(overrides = {}) {
  const env = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    PI_CODING_AGENT_DIR: agentDir,
    COMMAND_CODE_API_KEY: "mock-key",
    COMMANDCODE_API_BASE: `${apiBase}/provider/v1`,
    COMMANDCODE_MODELS_URL: `${apiBase}/provider/v1/models`,
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

// Same DDL OMP 18 runs for its credential store; OMP's own migration is
// `CREATE TABLE IF NOT EXISTS`, so creating it first is safe.
const OMP_AUTH_CREDENTIALS_DDL = `CREATE TABLE IF NOT EXISTS auth_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  data TEXT NOT NULL,
  disabled_cause TEXT DEFAULT NULL,
  identity_key TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
)`

/**
 * Store a credential the way OMP's `/login` does: in the `auth_credentials`
 * table of `agent.db`. OMP is a Bun binary, so `bun:sqlite` is always
 * available next to it and matches the SQLite build OMP itself uses.
 * Pass `undefined` to remove any stored Command Code credential.
 */
function seedOmpCredential(credential) {
  const rows =
    credential === undefined
      ? []
      : [
          [
            credential.type,
            JSON.stringify(
              credential.type === "oauth"
                ? {
                    access: credential.access,
                    refresh: credential.refresh,
                    expires: credential.expires,
                  }
                : { key: credential.key, source: "login" },
            ),
          ],
        ]
  const script = `
    import { Database } from "bun:sqlite"
    // \`bun -e\` has no script slot: argv is [bun, ...args].
    const [dbPath, ddl, rowsJson] = process.argv.slice(1)
    const db = new Database(dbPath)
    db.run(ddl)
    db.run("DELETE FROM auth_credentials WHERE provider = ?", ["commandcode"])
    for (const [type, data] of JSON.parse(rowsJson)) {
      db.run(
        "INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)",
        ["commandcode", type, data],
      )
    }
    db.close()
  `
  const result = spawnSync(
    "bun",
    ["-e", script, join(agentDir, "agent.db"), OMP_AUTH_CREDENTIALS_DDL, JSON.stringify(rows)],
    { env: ompEnv(), encoding: "utf-8" },
  )
  assert.equal(result.status, 0, result.stderr)
}

function runOmp(args, timeoutOrOptions = 30_000) {
  const options =
    typeof timeoutOrOptions === "number" ? { timeoutMs: timeoutOrOptions } : timeoutOrOptions
  const timeoutMs = options.timeoutMs ?? 30_000
  return new Promise((resolve) => {
    const child = spawn(OMP_BIN, args, {
      cwd: PROJECT_DIR,
      env: ompEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\nTIMEOUT after ${timeoutMs}ms`,
      })
    }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8")
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8")
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

try {
  console.log("[omp-compat] extension loads against the host's pi packages")
  // OMP remaps `@earendil-works/pi-ai/compat` onto its own pi-ai and rejects
  // any named import that module does not export, both in `omp plugin
  // install` validation and when loading the extension. 0.6.1 shipped such an
  // import and could not be installed on omp 18 (#74). `omp models -e EXT`
  // runs the same loader, so it reproduces that failure without a registry.
  const load = await runOmp(["models", "-e", EXT_PATH])
  assert.equal(load.code, 0, load.stderr)
  assert.doesNotMatch(
    load.stdout + load.stderr,
    /Failed to load extension|not found in module/,
    "the extension must only import what OMP's bundled pi packages export",
  )

  console.log("[omp-compat] list models through real extension")
  modelListRequestCount = 0
  // Prefer the flag form `omp -e EXT --list-models`; Homebrew's `omp`
  // distribution only exposes the `omp models` subcommand, so fall back to
  // that form when the flag invocation is not recognized.
  let result = await runOmp(["-e", EXT_PATH, "--list-models"])
  if (result.code !== 0) {
    result = await runOmp(["models", "-e", EXT_PATH])
  }
  assert.equal(result.code, 0, result.stderr)
  const listOutput = result.stdout || result.stderr
  assert.match(listOutput, /commandcode/)
  assert.match(listOutput, /deepseek\/deepseek-v4-flash/)
  // The failed flag attempt may already load the extension and fetch the
  // catalog once before the subcommand fallback runs, so only assert that
  // the mock catalog was actually consulted.
  assert.ok(modelListRequestCount >= 1)
  assert.doesNotThrow(() =>
    accessSync(join(tempHome, ".omp", "agent", "commandcode-models.json"), constants.R_OK),
  )
  assert.doesNotMatch(result.stdout + result.stderr, /Failed to load extension/)

  console.log("[omp-compat] print mode through real extension and mock API")
  requestCount = 0
  requestBodies = []
  const print = await runOmp(
    ["-e", EXT_PATH, "-p", "say mock token", "--model", `commandcode/${TEST_MODEL}`],
    30_000,
  )
  assert.equal(print.code, 0, print.stderr)
  assert.match(print.stdout, /mock-omp-ok/)
  assert.equal(requestCount, 1)
  assert.equal(
    lastRequestHeaders.authorization,
    "Bearer mock-key",
    "should send the resolved env-var value, not the literal var name",
  )
  assert.equal(lastRequestBody?.model, TEST_MODEL)
  assert.ok(Array.isArray(lastRequestBody?.messages))

  // OMP stores `/login` credentials in agent.db and consults them only when
  // the extension does not install a config API key. main registered the
  // unresolved `$COMMAND_CODE_API_KEY` placeholder, which OMP kept as a
  // literal config override and sent as the Bearer token, so stored
  // credentials never reached the request (401).
  const chatArgs = ["-e", EXT_PATH, "-p", "say mock token", "--model", `commandcode/${TEST_MODEL}`]
  const noEnvKey = { COMMAND_CODE_API_KEY: undefined, COMMANDCODE_API_KEY: undefined }

  console.log("[omp-compat] stored /login OAuth credential is used when no env key exists")
  seedOmpCredential({
    type: "oauth",
    access: "stored-oauth-token",
    refresh: "stored-oauth-token",
    expires: Date.now() + 24 * 60 * 60 * 1000,
  })
  requestCount = 0
  lastRequestHeaders = {}
  const oauthChat = await runOmp(chatArgs, { env: noEnvKey })
  assert.equal(oauthChat.code, 0, oauthChat.stderr)
  assert.match(oauthChat.stdout, /mock-omp-ok/)
  assert.equal(requestCount, 1)
  assert.equal(lastRequestHeaders.authorization, "Bearer stored-oauth-token")

  console.log("[omp-compat] stored /login API key credential is used when no env key exists")
  seedOmpCredential({ type: "api_key", key: "stored-api-key" })
  requestCount = 0
  lastRequestHeaders = {}
  const apiKeyChat = await runOmp(chatArgs, { env: noEnvKey })
  assert.equal(apiKeyChat.code, 0, apiKeyChat.stderr)
  assert.match(apiKeyChat.stdout, /mock-omp-ok/)
  assert.equal(requestCount, 1)
  assert.equal(lastRequestHeaders.authorization, "Bearer stored-api-key")

  console.log("[omp-compat] --api-key wins over a stored credential")
  requestCount = 0
  lastRequestHeaders = {}
  const cliKeyChat = await runOmp([...chatArgs, "--api-key", "cli-key"], { env: noEnvKey })
  assert.equal(cliKeyChat.code, 0, cliKeyChat.stderr)
  assert.match(cliKeyChat.stdout, /mock-omp-ok/)
  assert.equal(requestCount, 1)
  assert.equal(lastRequestHeaders.authorization, "Bearer cli-key")

  console.log("[omp-compat] COMMAND_CODE_API_KEY still works alongside a stored credential")
  requestCount = 0
  lastRequestHeaders = {}
  const envKeyChat = await runOmp(chatArgs)
  assert.equal(envKeyChat.code, 0, envKeyChat.stderr)
  assert.match(envKeyChat.stdout, /mock-omp-ok/)
  assert.equal(requestCount, 1)
  assert.match(lastRequestHeaders.authorization ?? "", /^Bearer (mock-key|stored-api-key)$/)

  console.log("[omp-compat] no credential at all never sends the placeholder")
  seedOmpCredential(undefined)
  requestCount = 0
  lastRequestHeaders = {}
  const noKeyChat = await runOmp(chatArgs, { env: noEnvKey })
  assert.equal(requestCount, 0, JSON.stringify(lastRequestHeaders))
  assert.doesNotMatch(noKeyChat.stdout + noKeyChat.stderr, /\$COMMAND_CODE_API_KEY/)

  console.log("[omp-compat] developer advisory reaches the legacy generate request body")
  requestCount = 0
  requestBodies = []
  providerUpgradeRequired = true
  const advisoryRun = await runOmp(
    [
      "-e",
      EXT_PATH,
      "-e",
      ADVISORY_EXT_PATH,
      "-p",
      "say mock token",
      "--model",
      `commandcode/${TEST_MODEL}`,
      "--no-tools",
      "--no-title",
    ],
    30_000,
  )
  assert.equal(advisoryRun.code, 0, advisoryRun.stderr)
  assert.match(advisoryRun.stdout, /mock-omp-ok/)

  const promptBodies = requestBodies.filter((body) =>
    JSON.stringify(body?.params?.messages ?? []).includes("say mock token"),
  )
  assert.ok(promptBodies.length >= 1, "expected at least one generate request with the prompt")

  for (const body of promptBodies) {
    const messages = body?.params?.messages ?? []
    const advisoryMessages = messages.filter((message) =>
      JSON.stringify(message).includes("Stop and correct the benchmark."),
    )
    assert.equal(advisoryMessages.length, 1, "the advisory should survive conversion exactly once")
    const advisoryMessage = advisoryMessages[0]
    assert.equal(advisoryMessage.role, "user")
    const advisoryText =
      typeof advisoryMessage.content === "string"
        ? advisoryMessage.content
        : (advisoryMessage.content ?? [])
            .map((part) => (part?.type === "text" ? part.text : ""))
            .join("\n")
    assert.equal(advisoryText, ADVISORY_XML, "advisory content must arrive verbatim")

    const advisoryIndex = messages.indexOf(advisoryMessage)
    const promptIndex = messages.findIndex((message) =>
      JSON.stringify(message).includes("say mock token"),
    )
    assert.ok(
      advisoryIndex < promptIndex,
      "advisory must keep its chronological position relative to the prompt",
    )
    assert.doesNotMatch(
      String(body?.params?.system ?? ""),
      /Stop and correct the benchmark|<advisory/,
      "advisory must not be hoisted into the system prompt",
    )
  }

  console.log("[omp-compat] PASS")
} finally {
  await new Promise((resolve) => server.close(resolve))
  rmSync(tempHome, { recursive: true, force: true })
}
