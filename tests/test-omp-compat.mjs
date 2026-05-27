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
import { spawn } from "node:child_process"
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = resolve(__dirname, "..")
const EXT_PATH = resolve(PROJECT_DIR, "index.ts")
const TEST_MODEL = "deepseek/deepseek-v4-flash"

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
  console.log("[omp-compat] SKIP - omp is not on PATH")
  process.exit(0)
}

const tempHome = mkdtempSync(join(tmpdir(), "omp-cc-home-"))
let requestCount = 0
let lastRequestBody
let lastRequestHeaders = {}

const server = createServer((req, res) => {
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

  let body = ""
  req.on("data", (chunk) => {
    body += chunk.toString("utf-8")
  })
  req.on("end", () => {
    try {
      lastRequestBody = JSON.parse(body)
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

function runOmp(args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(OMP_BIN, args, {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        PI_CODING_AGENT_DIR: join(tempHome, ".omp", "agent"),
        COMMANDCODE_API_KEY: "mock-key",
        COMMANDCODE_API_BASE: apiBase,
      },
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
  console.log("[omp-compat] list models through real extension")
  const result = await runOmp(["-e", EXT_PATH, "--list-models"])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /commandcode/)
  assert.match(result.stdout, /deepseek\/deepseek-v4-flash/)
  assert.doesNotMatch(result.stdout + result.stderr, /Failed to load extension/)

  console.log("[omp-compat] print mode through real extension and mock API")
  requestCount = 0
  const print = await runOmp(
    ["-e", EXT_PATH, "-p", "say mock token", "--model", `commandcode/${TEST_MODEL}`],
    30_000,
  )
  assert.equal(print.code, 0, print.stderr)
  assert.match(print.stdout, /mock-omp-ok/)
  assert.equal(requestCount, 1)
  assert.ok(
    typeof lastRequestHeaders.authorization === "string" &&
      lastRequestHeaders.authorization.startsWith("Bearer "),
    "should send a bearer Authorization header",
  )
  assert.equal(lastRequestBody?.params?.model, TEST_MODEL)
  assert.equal(typeof lastRequestBody?.params?.system, "string")

  console.log("[omp-compat] PASS")
} finally {
  await new Promise((resolve) => server.close(resolve))
  rmSync(tempHome, { recursive: true, force: true })
}
