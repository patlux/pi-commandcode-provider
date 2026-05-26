/**
 * Integration smoke test for pi-commandcode-provider.
 *
 * Tests that the extension:
 * 1. Loads without crashing in print mode
 * 2. Registers the provider and models
 * 3. Can complete a simple prompt (requires Command Code auth)
 *
 * Run with: node tests/test-smoke.mjs
 * Requires: pi on PATH plus COMMANDCODE_API_KEY or live pi auth files.
 */

import { spawn } from "node:child_process"
import { accessSync, constants, existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = resolve(__dirname, "..")
const EXT_PATH = resolve(PROJECT_DIR, "index.ts")
const TEST_MODEL = "deepseek/deepseek-v4-flash"

function findPiBinary() {
  if (process.env.PI_BIN) return process.env.PI_BIN
  const localBin = resolve(PROJECT_DIR, "node_modules", ".bin")
  const candidates = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => resolve(entry, "pi"))
    .filter((candidate) => !candidate.startsWith(localBin))
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

const PI_BIN = findPiBinary()
const HAS_PI = !!PI_BIN

const PRINT_MODE_TIMEOUT = 120_000 // 2 minutes for print mode
const RPC_START_TIMEOUT = 15_000
const RPC_QUERY_TIMEOUT = 60_000

function hasCommandCodeAuth() {
  return (
    !!process.env.COMMANDCODE_API_KEY ||
    existsSync(join(homedir(), ".commandcode", "auth.json")) ||
    existsSync(join(homedir(), ".omp", "agent", "auth.json")) ||
    existsSync(join(homedir(), ".pi", "agent", "auth.json"))
  )
}

const HAS_AUTH = hasCommandCodeAuth()

let passed = 0
let failed = 0
let skipped = 0

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function kill(child) {
  try {
    child.kill()
  } catch {
    // ignore
  }
}

// -------------------------------------------------------------------------
// Test 1: Print mode — extension loads and agent runs
// -------------------------------------------------------------------------

async function runPrintMode() {
  if (!HAS_AUTH) {
    console.log("[smoke] SKIP — Command Code auth not found, skipping print mode test\n")
    skipped++
    return
  }
  if (!HAS_PI) {
    console.log("[smoke] SKIP — pi is not on PATH, skipping print mode test\n")
    skipped++
    return
  }

  console.log(`[smoke] Running pi in print mode with extension: ${EXT_PATH}`)
  console.log(
    `[smoke]   ${PI_BIN} -e ${EXT_PATH} -p "say hi" --provider commandcode --model ${TEST_MODEL}\n`,
  )

  const child = spawn(
    PI_BIN,
    [
      "-e",
      EXT_PATH,
      "-p",
      "say hi in one word",
      "--provider",
      "commandcode",
      "--model",
      TEST_MODEL,
    ],
    {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let stdout = ""
  let stderr = ""

  child.stdout.on("data", (d) => {
    stdout += d.toString()
  })
  child.stderr.on("data", (d) => {
    stderr += d.toString()
  })

  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      kill(child)
      console.log("[smoke] TIMEOUT — pi print mode took too long")
      resolve(false)
    }, PRINT_MODE_TIMEOUT)

    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) {
        console.log("[smoke] PASS — extension loaded and agent ran without crash")
        console.log(`[smoke] stdout (last 300 chars): ${stdout.slice(-300).trim()}`)
      } else {
        console.log(`[smoke] FAIL — exit code ${code}`)
        console.log(`[smoke] stderr (last 500 chars): ${stderr.slice(-500).trim()}`)
      }
      resolve(code === 0)
    })
  })

  const ok = await done
  if (ok) passed++
  else failed++
}

// -------------------------------------------------------------------------
// Test 2: Print mode — provider discovery (list models)
// -------------------------------------------------------------------------

async function runListModels() {
  if (!HAS_AUTH) {
    console.log("[smoke] SKIP — Command Code auth not found, skipping model list test\n")
    skipped++
    return
  }
  if (!HAS_PI) {
    console.log("[smoke] SKIP — pi is not on PATH, skipping model list test\n")
    skipped++
    return
  }

  console.log(`[smoke] Checking that models are discoverable via pi --list-models\n`)

  const child = spawn(PI_BIN, ["-e", EXT_PATH, "--list-models"], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""

  child.stdout.on("data", (d) => {
    stdout += d.toString()
  })

  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      kill(child)
      console.log("[smoke] TIMEOUT — model listing took too long")
      resolve(false)
    }, 15_000)

    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0 && stdout.includes("commandcode")) {
        console.log("[smoke] PASS — commandcode provider models are listed")
      } else {
        console.log("[smoke] FAIL — commandcode models not found or error listing")
        console.log(`[smoke] stdout (last 500 chars): ${stdout.slice(-500).trim()}`)
      }
      resolve(code === 0 && stdout.includes("commandcode"))
    })
  })

  const ok = await done
  if (ok) passed++
  else failed++
}

// -------------------------------------------------------------------------
// Test 3: RPC mode — extension loads and answers get_state
// -------------------------------------------------------------------------

async function runRpcStartup() {
  if (!HAS_AUTH) {
    console.log("[smoke] SKIP — Command Code auth not found, skipping RPC startup test\n")
    skipped++
    return
  }
  if (!HAS_PI) {
    console.log("[smoke] SKIP — pi is not on PATH, skipping RPC startup test\n")
    skipped++
    return
  }

  console.log(`[smoke] Testing RPC mode startup with extension\n`)
  console.log(`[smoke]   ${PI_BIN} --mode rpc -e ${EXT_PATH}\n`)

  const child = spawn(PI_BIN, ["--mode", "rpc", "-e", EXT_PATH], {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  })

  let sawStateResponse = false
  let sawError = false
  const events = []

  let buf = ""
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf-8")
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed)
        events.push(msg)
        if (
          msg.type === "response" &&
          msg.id === "state-1" &&
          msg.command === "get_state" &&
          msg.success === true
        ) {
          sawStateResponse = true
          console.log("[smoke] RPC received get_state response")
        }
        if (msg.type === "error" || msg.type === "fatal") {
          sawError = true
          console.error(`[smoke] RPC error: ${JSON.stringify(msg).slice(0, 300)}`)
        }
      } catch {
        // ignore non-JSON
      }
    }
  })

  const result = new Promise((resolve) => {
    child.stdin.write(JSON.stringify({ id: "state-1", type: "get_state" }) + "\n")

    const timer = setTimeout(async () => {
      if (sawStateResponse) {
        console.log("[smoke] PASS — extension loaded and RPC get_state works")
        resolve(true)
      } else {
        console.log("[smoke] FAIL — get_state response not received")
        resolve(false)
      }
      // Send quit
      try {
        child.stdin.write(JSON.stringify({ type: "quit" }) + "\n")
      } catch {}
      kill(child)
    }, RPC_START_TIMEOUT)

    child.on("close", (code) => {
      clearTimeout(timer)
      if (!sawStateResponse && !sawError) {
        console.log(`[smoke] FAIL — pi exited with code ${code} before get_state response`)
        resolve(false)
      }
    })
  })

  const ok = await result
  if (ok) passed++
  else failed++
}

// -------------------------------------------------------------------------
// Test 4: RPC mode — send prompt and receive assistant message
// -------------------------------------------------------------------------

async function runRpcQuery() {
  if (!HAS_AUTH) {
    console.log("[smoke] SKIP — Command Code auth not found, skipping RPC prompt test\n")
    skipped++
    return
  }
  if (!HAS_PI) {
    console.log("[smoke] SKIP — pi is not on PATH, skipping RPC prompt test\n")
    skipped++
    return
  }

  console.log(`[smoke] Testing RPC prompt flow\n`)
  console.log(`[smoke]   pi --mode rpc -e ${EXT_PATH} → prompt "say hi" → expect response\n`)

  const child = spawn(
    PI_BIN,
    ["--mode", "rpc", "-e", EXT_PATH, "--provider", "commandcode", "--model", TEST_MODEL],
    {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

  let sawPromptAccepted = false
  let sawAssistantMessage = false

  let buf = ""
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf-8")
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed)
        if (
          msg.type === "response" &&
          msg.id === "prompt-1" &&
          msg.command === "prompt" &&
          msg.success === true
        ) {
          sawPromptAccepted = true
        }
        if (msg.type === "message_end" && msg.message?.role === "assistant") {
          sawAssistantMessage = true
          console.log("[smoke] PASS — received assistant message_end in RPC mode")
        }
      } catch {
        // ignore
      }
    }
  })

  const result = new Promise((resolve) => {
    child.stdin.write(
      JSON.stringify({
        id: "prompt-1",
        type: "prompt",
        message: "say hi in one word",
      }) + "\n",
    )
    console.log("[smoke] Sent RPC prompt")

    const timer = setTimeout(() => {
      if (sawPromptAccepted && sawAssistantMessage) {
        console.log("[smoke] PASS — full RPC prompt/response cycle works")
        resolve(true)
      } else {
        console.log("[smoke] WARN — no assistant message_end received (may still be streaming)")
        resolve(false)
      }
      try {
        child.stdin.write(JSON.stringify({ type: "quit" }) + "\n")
      } catch {}
      kill(child)
    }, RPC_QUERY_TIMEOUT)

    child.on("close", (code) => {
      clearTimeout(timer)
      if (!sawAssistantMessage) {
        console.log(`[smoke] FAIL — pi exited before assistant message_end`)
        resolve(false)
      }
    })
  })

  const ok = await result
  if (ok) passed++
  else failed++
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

console.log("=".repeat(60))
console.log("  pi-commandcode-provider Integration Smoke Test")
console.log("=".repeat(60))
console.log(`  Auth: ${HAS_AUTH ? "✓ found" : "✗ not found (tests will be skipped)"}`)
console.log(`  Extension: ${EXT_PATH}`)
console.log("=".repeat(60))
console.log("")

await runPrintMode()
await runListModels()
await runRpcStartup()
await runRpcQuery()

console.log("")
console.log("=".repeat(60))
console.log(`  SUITE RESULT: ${passed} passed, ${failed} failed, ${skipped} skipped`)
console.log("=".repeat(60))

process.exit(failed > 0 ? 1 : 0)
