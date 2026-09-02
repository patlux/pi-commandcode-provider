#!/usr/bin/env node
/**
 * Local end-to-end test: loads the real extension through the pi CLI while the
 * Command Code API is replaced by a deterministic local mock server.
 */

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = resolve(__dirname, "..")
const EXT_PATH = resolve(PROJECT_DIR, "index.ts")
const COMPAT_CALLER_EXT_PATH = resolve(
  PROJECT_DIR,
  "tests",
  "fixtures",
  "compat-caller-extension.ts",
)
const TEST_MODEL = "gpt-5.4"
const CLAUDE_TEST_MODEL = "claude-sonnet-4-6"

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
if (!PI_BIN) {
  console.log("[pi-local] SKIP — pi is not on PATH")
  process.exit(0)
}

const piCheck = spawnSync(PI_BIN, ["--help"], { stdio: "ignore" })
if (piCheck.error) {
  console.log(`[pi-local] SKIP — pi failed to start: ${piCheck.error.message}`)
  process.exit(0)
}

let requestCount = 0
let modelListRequestCount = 0
let lastRequestBody
let lastRequestHeaders = {}
let overflowMode = false
let overflowRequestCount = 0
let modelsDelayMs = 0
let includeRefreshedModel = false

function modelCatalog() {
  const data = [
    {
      id: TEST_MODEL,
      object: "model",
      created: 1779824324,
      owned_by: "command-code",
      name: "GPT 5.4",
      context_length: 1_000_000,
    },
    {
      id: CLAUDE_TEST_MODEL,
      object: "model",
      created: 1779824324,
      owned_by: "command-code",
      name: "Claude Sonnet 4.6",
      context_length: 200_000,
    },
    {
      id: "cc-second-model",
      object: "model",
      created: 1779824324,
      owned_by: "command-code",
      name: "Qwen 3.7 Max",
      context_length: 1_000_000,
    },
  ]
  if (includeRefreshedModel) {
    data.push({
      id: "cc-refreshed-model",
      object: "model",
      created: 1779824324,
      owned_by: "command-code",
      name: "Refreshed Model",
      context_length: 200_000,
    })
  }
  return { object: "list", data }
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/provider/v1/models") {
    modelListRequestCount += 1
    const respond = () => {
      if (res.destroyed) return
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify(modelCatalog()))
    }
    if (modelsDelayMs > 0) setTimeout(respond, modelsDelayMs)
    else respond()
    return
  }

  const isOpenAIRequest = req.method === "POST" && req.url === "/provider/v1/chat/completions"
  const isAnthropicRequest = req.method === "POST" && req.url === "/provider/v1/messages"
  if (!isOpenAIRequest && !isAnthropicRequest) {
    res.writeHead(404)
    res.end("Not found")
    return
  }

  requestCount += 1
  if (overflowMode) overflowRequestCount += 1
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

    if (overflowMode && overflowRequestCount === 2) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" })
      res.end(
        JSON.stringify({
          error: {
            message: "Input exceeds context limit",
            type: "invalid_request_error",
            code: "context_length_exceeded",
          },
        }),
      )
      return
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Transfer-Encoding": "chunked",
    })
    const text = overflowMode
      ? overflowRequestCount === 1
        ? "overflow-initial"
        : overflowRequestCount === 3
          ? "compaction-summary"
          : "overflow-recovered"
      : "mock-pi-ok"
    if (isAnthropicRequest) {
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "mock", type: "message", role: "assistant", content: [], model: CLAUDE_TEST_MODEL, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
      )
      res.write(
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      )
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
      )
      res.write(
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      )
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`,
      )
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`)
      return
    }

    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
    )
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    )
    res.write(
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    )
    res.end("data: [DONE]\n\n")
  })
})

await new Promise((resolve) => server.listen(0, resolve))
const address = server.address()
const port = typeof address === "object" && address ? address.port : 0
const apiBase = `http://127.0.0.1:${port}`

const tempHome = mkdtempSync(join(tmpdir(), "pi-cc-home-"))
const agentDir = join(tempHome, "custom-pi-agent")
mkdirSync(agentDir, { recursive: true })
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ compaction: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 } }),
)
const env = {
  ...process.env,
  HOME: tempHome,
  USERPROFILE: tempHome,
  PI_CODING_AGENT_DIR: agentDir,
  PI_CODING_AGENT_SESSION_DIR: join(tempHome, "sessions"),
  COMMANDCODE_API_BASE: `${apiBase}/provider/v1`,
  COMMAND_CODE_API_KEY: "mock-key",
  CMD_ZDR: "1",
  COMMANDCODE_MODELS_URL: `${apiBase}/provider/v1/models`,
}

function runPi(args, timeoutOrOptions = 30_000) {
  const options =
    typeof timeoutOrOptions === "number" ? { timeoutMs: timeoutOrOptions } : timeoutOrOptions
  const timeoutMs = options.timeoutMs ?? 30_000
  const childEnv = { ...env }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete childEnv[key]
    else childEnv[key] = value
  }
  return new Promise((resolve) => {
    const child = spawn(PI_BIN, args, {
      cwd: PROJECT_DIR,
      env: childEnv,
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

async function runRpcQuery(
  timeoutMs = 30_000,
  promptMessage = "say mock token",
  extraArgs = [],
  promptFields = {},
) {
  const child = spawn(
    PI_BIN,
    [
      "--no-extensions",
      "--mode",
      "rpc",
      "-e",
      EXT_PATH,
      "--provider",
      "commandcode",
      "--model",
      TEST_MODEL,
      ...extraArgs,
    ],
    {
      cwd: PROJECT_DIR,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

  let stdout = ""
  let stderr = ""
  let buffer = ""
  let sawPromptAccepted = false
  let sawAssistantMessage = false
  let sawTextDelta = false
  const events = []

  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, timeoutMs)

    const finish = (ok) => {
      clearTimeout(timer)
      try {
        child.stdin.write(`${JSON.stringify({ type: "quit" })}\n`)
      } catch {
        // ignore shutdown race
      }
      child.kill()
      resolve(ok)
    }

    child.stdin.write(
      `${JSON.stringify({
        id: "prompt-1",
        type: "prompt",
        message: promptMessage,
        ...promptFields,
      })}\n`,
    )

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf-8")
      stdout += text
      buffer += text
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          events.push(event)
          if (event.type === "response" && event.id === "prompt-1" && event.success === true) {
            sawPromptAccepted = true
          }
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta"
          ) {
            sawTextDelta = true
          }
          if (event.type === "message_end" && event.message?.role === "assistant") {
            sawAssistantMessage = true
            finish(true)
          }
        } catch {
          // ignore non-JSON output
        }
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8")
    })
    child.on("close", () => {
      if (!sawAssistantMessage) finish(false)
    })
  })

  const ok = await done
  return {
    ok,
    stdout,
    stderr,
    events,
    sawPromptAccepted,
    sawAssistantMessage,
    sawTextDelta,
  }
}

async function runRpcExtensionCommands(timeoutMs = 30_000) {
  const child = spawn(
    PI_BIN,
    [
      "--no-extensions",
      "--mode",
      "rpc",
      "-e",
      EXT_PATH,
      "--provider",
      "commandcode",
      "--model",
      TEST_MODEL,
    ],
    {
      cwd: PROJECT_DIR,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

  let buffer = ""
  let stderr = ""
  const events = []
  const waiters = []

  const publish = (event) => {
    events.push(event)
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (!waiter.predicate(event)) continue
      waiters.splice(index, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(event)
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8")
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        publish(JSON.parse(line))
      } catch {
        // Ignore non-JSON output.
      }
    }
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf-8")
  })

  const waitFor = (predicate) =>
    new Promise((resolve, reject) => {
      const existing = events.find(predicate)
      if (existing) {
        resolve(existing)
        return
      }
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error(`RPC event timeout. stderr: ${stderr.slice(-500)}`))
      }, timeoutMs)
      waiters.push({ predicate, resolve, timer })
    })

  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`)

  try {
    send({ id: "commands", type: "get_commands" })
    const commandsResponse = await waitFor(
      (event) => event.type === "response" && event.id === "commands",
    )
    const commandNames = commandsResponse.data?.commands?.map((command) => command.name) ?? []

    send({ id: "status-before", type: "prompt", message: "/commandcode-status" })
    await waitFor(
      (event) => event.type === "response" && event.id === "status-before" && event.success,
    )
    const statusBefore = await waitFor(
      (event) =>
        event.type === "extension_ui_request" &&
        event.method === "notify" &&
        typeof event.message === "string" &&
        event.message.includes("model count: 3"),
    )

    includeRefreshedModel = true
    send({ id: "refresh", type: "prompt", message: "/commandcode-refresh" })
    await waitFor((event) => event.type === "response" && event.id === "refresh" && event.success)
    const refreshNotification = await waitFor(
      (event) =>
        event.type === "extension_ui_request" &&
        event.method === "notify" &&
        typeof event.message === "string" &&
        event.message.includes("4 models from live"),
    )

    send({ id: "status-after", type: "prompt", message: "/commandcode-status" })
    await waitFor(
      (event) => event.type === "response" && event.id === "status-after" && event.success,
    )
    const statusAfter = await waitFor(
      (event) =>
        event.type === "extension_ui_request" &&
        event.method === "notify" &&
        typeof event.message === "string" &&
        event.message.includes("model count: 4"),
    )

    return {
      commandNames,
      statusBefore: statusBefore.message,
      refreshNotification: refreshNotification.message,
      statusAfter: statusAfter.message,
      stderr,
    }
  } finally {
    child.kill()
  }
}

async function runRpcCompatCall(timeoutMs = 30_000) {
  const child = spawn(
    PI_BIN,
    [
      "--no-extensions",
      "--mode",
      "rpc",
      "-e",
      EXT_PATH,
      "-e",
      COMPAT_CALLER_EXT_PATH,
      "--provider",
      "commandcode",
      "--model",
      TEST_MODEL,
    ],
    {
      cwd: PROJECT_DIR,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

  let buffer = ""
  let stderr = ""

  const notification = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`compat-call timeout. stderr: ${stderr.slice(-500)}`)),
      timeoutMs,
    )
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf-8")
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (
          event.type === "extension_ui_request" &&
          event.method === "notify" &&
          typeof event.message === "string" &&
          event.message.startsWith("compat-call")
        ) {
          clearTimeout(timer)
          resolve(event.message)
        }
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8")
    })
  })

  try {
    child.stdin.write(
      `${JSON.stringify({ id: "compat", type: "prompt", message: "/compat-call" })}\n`,
    )
    return { message: await notification, stderr }
  } finally {
    child.kill()
  }
}

async function runRpcOverflowRecovery(timeoutMs = 60_000) {
  const child = spawn(
    PI_BIN,
    [
      "--no-extensions",
      "--mode",
      "rpc",
      "-e",
      EXT_PATH,
      "--provider",
      "commandcode",
      "--model",
      TEST_MODEL,
    ],
    {
      cwd: PROJECT_DIR,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

  let buffer = ""
  let stderr = ""
  const events = []
  let firstSettled = false
  let recovered = false

  const result = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false })
    }, timeoutMs)

    const finish = (ok) => {
      clearTimeout(timer)
      child.kill()
      resolve({ ok })
    }

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf-8")
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        events.push(event)
        if (event.type === "agent_settled" && !firstSettled) {
          firstSettled = true
          child.stdin.write(
            `${JSON.stringify({ id: "overflow-prompt", type: "prompt", message: "trigger overflow recovery" })}\n`,
          )
        }
        if (
          event.type === "compaction_end" &&
          event.reason === "overflow" &&
          event.willRetry === true
        ) {
          recovered = true
        }
        if (recovered && event.type === "agent_settled") finish(true)
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8")
    })
    child.stdin.write(
      `${JSON.stringify({ id: "initial-prompt", type: "prompt", message: "initial turn" })}\n`,
    )
  })

  const outcome = await result
  return {
    ...outcome,
    requests: overflowRequestCount,
    sawNormalizedOverflow: events.some(
      (event) =>
        event.type === "message_end" &&
        event.message?.role === "assistant" &&
        typeof event.message.errorMessage === "string" &&
        event.message.errorMessage.startsWith("context_length_exceeded:"),
    ),
    sawCompactionRetry: events.some(
      (event) => event.type === "compaction_end" && event.reason === "overflow" && event.willRetry,
    ),
    stderrHasSecrets: /mock-key|user_secret|api_key/i.test(stderr),
  }
}

try {
  console.log("[pi-local] first offline start without a cache")
  const onlineModelsUrl = env.COMMANDCODE_MODELS_URL
  env.COMMANDCODE_MODELS_URL = "http://127.0.0.1:1/provider/v1/models"
  const modelsCachePath = join(env.PI_CODING_AGENT_DIR, "commandcode-models.json")
  rmSync(modelsCachePath, { force: true })
  const firstOfflineList = await runPi(
    ["--no-extensions", "-e", EXT_PATH, "--list-models", "commandcode"],
    20_000,
  )
  assert.equal(firstOfflineList.code, 0, firstOfflineList.stderr)
  assert.doesNotMatch(firstOfflineList.stderr, /Failed to load extension/)
  assert.match(
    firstOfflineList.stdout || firstOfflineList.stderr,
    /No models matching|No models available/,
  )
  assert.match(firstOfflineList.stderr, /no valid cached catalog/)
  assert.match(firstOfflineList.stderr, /until \/commandcode-refresh succeeds/)
  assert.throws(() => accessSync(modelsCachePath, constants.R_OK), /ENOENT|no such file/i)

  // A fresh process re-runs the extension entrypoint, which is the same path /reload uses.
  console.log("[pi-local] recover models after empty offline start")
  env.COMMANDCODE_MODELS_URL = onlineModelsUrl
  modelListRequestCount = 0
  const recoveryList = await runPi(
    ["--no-extensions", "-e", EXT_PATH, "--list-models", "commandcode"],
    20_000,
  )
  assert.equal(recoveryList.code, 0, recoveryList.stderr)
  const recoveryOutput = recoveryList.stdout || recoveryList.stderr
  assert.match(recoveryOutput, /gpt-5\.4/)
  assert.match(recoveryOutput, /cc-second-model/)
  assert.doesNotMatch(recoveryList.stderr, /no valid cached catalog/)
  assert.doesNotMatch(recoveryList.stderr, /Failed to load extension/)
  assert.equal(modelListRequestCount, 1)
  assert.doesNotThrow(() => accessSync(modelsCachePath, constants.R_OK))

  console.log("[pi-local] list models through real extension")
  modelListRequestCount = 0
  const list = await runPi(["--no-extensions", "-e", EXT_PATH, "--list-models"], 20_000)
  assert.equal(list.code, 0, list.stderr)
  const listOutput = list.stdout || list.stderr
  assert.match(listOutput, /commandcode/)
  assert.match(listOutput, /gpt-5\.4/)
  assert.match(listOutput, /cc-second-model/)
  assert.equal(modelListRequestCount, 1)
  assert.doesNotThrow(() => accessSync(modelsCachePath, constants.R_OK))

  console.log("[pi-local] list cached models while model discovery is offline")
  env.COMMANDCODE_MODELS_URL = "http://127.0.0.1:1/provider/v1/models"
  const offlineList = await runPi(
    ["--no-extensions", "-e", EXT_PATH, "--list-models", "commandcode"],
    20_000,
  )
  assert.equal(offlineList.code, 0, offlineList.stderr)
  const offlineListOutput = offlineList.stdout || offlineList.stderr
  assert.match(offlineListOutput, /gpt-5\.4/)
  assert.match(offlineListOutput, /cc-second-model/)
  assert.match(offlineList.stderr, /Using the cached catalog/)

  console.log("[pi-local] use a cached model while model discovery is offline")
  requestCount = 0
  const offlinePrint = await runPi(
    [
      "--no-extensions",
      "-e",
      EXT_PATH,
      "-p",
      "say mock token",
      "--provider",
      "commandcode",
      "--model",
      TEST_MODEL,
    ],
    30_000,
  )
  assert.equal(offlinePrint.code, 0, offlinePrint.stderr)
  assert.match(offlinePrint.stdout, /mock-pi-ok/)
  assert.match(offlinePrint.stderr, /Using the cached catalog/)
  assert.equal(requestCount, 1)
  env.COMMANDCODE_MODELS_URL = onlineModelsUrl

  console.log("[pi-local] discovery timeout through real extension")
  rmSync(modelsCachePath, { force: true })
  modelsDelayMs = 5_000
  env.COMMANDCODE_MODELS_TIMEOUT_MS = "50"
  const timeoutStartedAt = Date.now()
  const timedOutList = await runPi(
    ["--no-extensions", "-e", EXT_PATH, "--list-models", "commandcode"],
    5_000,
  )
  const timeoutElapsedMs = Date.now() - timeoutStartedAt
  assert.equal(timedOutList.code, 0, timedOutList.stderr)
  assert.ok(timeoutElapsedMs < 2_000, `model discovery took ${timeoutElapsedMs}ms`)
  assert.match(timedOutList.stderr, /timed out after 50ms/i)
  modelsDelayMs = 0
  delete env.COMMANDCODE_MODELS_TIMEOUT_MS

  console.log("[pi-local] cached catalog starts without waiting for slow discovery")
  const warmup = await runPi(
    ["--no-extensions", "-e", EXT_PATH, "--list-models", "commandcode"],
    20_000,
  )
  assert.equal(warmup.code, 0, warmup.stderr)
  assert.doesNotThrow(() => accessSync(modelsCachePath, constants.R_OK))
  modelsDelayMs = 5_000
  requestCount = 0
  const cachedStartedAt = Date.now()
  const cachedPrint = await runPi(
    [
      "--no-extensions",
      "-e",
      EXT_PATH,
      "-p",
      "say mock token",
      "--provider",
      "commandcode",
      "--model",
      TEST_MODEL,
    ],
    30_000,
  )
  const cachedElapsedMs = Date.now() - cachedStartedAt
  assert.equal(cachedPrint.code, 0, cachedPrint.stderr)
  assert.match(cachedPrint.stdout, /mock-pi-ok/)
  assert.equal(requestCount, 1)
  assert.ok(cachedElapsedMs < 5_000, `cached start took ${cachedElapsedMs}ms`)
  modelsDelayMs = 0

  console.log("[pi-local] print mode with reasoning and tool schemas")
  requestCount = 0
  const print = await runPi(
    [
      "--no-extensions",
      "-e",
      EXT_PATH,
      "-p",
      "say mock token",
      "--provider",
      "commandcode",
      "--model",
      TEST_MODEL,
      "--thinking",
      "high",
    ],
    30_000,
  )
  assert.equal(print.code, 0, print.stderr)
  assert.match(print.stdout, /mock-pi-ok/)
  assert.equal(requestCount, 1)
  assert.ok(
    typeof lastRequestHeaders.authorization === "string" &&
      lastRequestHeaders.authorization.startsWith("Bearer "),
    "should send a bearer Authorization header",
  )
  assert.equal(lastRequestHeaders["x-cmd-zdr"], "1")
  assert.equal(lastRequestBody?.model, TEST_MODEL)
  assert.equal(lastRequestBody?.reasoning_effort, "high")
  const sentTools = lastRequestBody?.tools
  assert.ok(Array.isArray(sentTools) && sentTools.length > 0)
  const editTool = sentTools.find((tool) => tool.function?.name === "edit")
  assert.equal(editTool?.function?.parameters?.type, "object")
  assert.equal(editTool?.function?.parameters?.properties?.edits?.type, "array")
  assert.equal(editTool?.function?.parameters?.properties?.edits?.items?.type, "object")
  assert.equal(
    editTool?.function?.parameters?.properties?.edits?.items?.properties?.oldText?.type,
    "string",
  )

  // pi resolves `/login` credentials, `--api-key`, and env keys through the
  // provider's registered auth methods. Stored credentials and `--api-key`
  // only reach the request when the provider keeps an API-key auth method
  // next to OAuth, so every credential source is checked without an env key.
  const authArgs = [
    "--no-extensions",
    "-e",
    EXT_PATH,
    "-p",
    "say mock token",
    "--provider",
    "commandcode",
    "--model",
    TEST_MODEL,
  ]
  const noEnvKey = { COMMAND_CODE_API_KEY: undefined, COMMANDCODE_API_KEY: undefined }
  const authPath = join(agentDir, "auth.json")

  console.log("[pi-local] stored /login OAuth credential is used when no env key exists")
  writeFileSync(
    authPath,
    JSON.stringify({
      commandcode: {
        type: "oauth",
        access: "stored-oauth-token",
        refresh: "stored-oauth-token",
        expires: Date.now() + 24 * 60 * 60 * 1000,
      },
    }),
  )
  requestCount = 0
  lastRequestHeaders = {}
  const oauthPrint = await runPi(authArgs, { env: noEnvKey })
  assert.equal(oauthPrint.code, 0, oauthPrint.stderr)
  assert.match(oauthPrint.stdout, /mock-pi-ok/)
  assert.equal(requestCount, 1)
  assert.equal(lastRequestHeaders.authorization, "Bearer stored-oauth-token")

  console.log("[pi-local] stored /login API key credential is used when no env key exists")
  writeFileSync(
    authPath,
    JSON.stringify({ commandcode: { type: "api_key", key: "stored-api-key" } }),
  )
  requestCount = 0
  lastRequestHeaders = {}
  const apiKeyPrint = await runPi(authArgs, { env: noEnvKey })
  assert.equal(apiKeyPrint.code, 0, apiKeyPrint.stderr)
  assert.match(apiKeyPrint.stdout, /mock-pi-ok/)
  assert.equal(requestCount, 1)
  assert.equal(lastRequestHeaders.authorization, "Bearer stored-api-key")

  console.log("[pi-local] --api-key is used when no env key or stored credential exists")
  rmSync(authPath, { force: true })
  requestCount = 0
  lastRequestHeaders = {}
  const cliKeyPrint = await runPi([...authArgs, "--api-key", "cli-key"], { env: noEnvKey })
  assert.equal(cliKeyPrint.code, 0, cliKeyPrint.stderr)
  assert.match(cliKeyPrint.stdout, /mock-pi-ok/)
  assert.equal(requestCount, 1)
  assert.equal(lastRequestHeaders.authorization, "Bearer cli-key")

  console.log("[pi-local] no credential at all never sends the placeholder")
  requestCount = 0
  lastRequestHeaders = {}
  const noKeyPrint = await runPi(authArgs, { env: noEnvKey })
  assert.notEqual(noKeyPrint.code, 0)
  assert.equal(requestCount, 0, JSON.stringify(lastRequestHeaders))
  assert.doesNotMatch(noKeyPrint.stdout + noKeyPrint.stderr, /\$COMMAND_CODE_API_KEY/)

  console.log("[pi-local] Claude request through Anthropic Messages endpoint")
  requestCount = 0
  const claudePrint = await runPi(
    [
      "--no-extensions",
      "-e",
      EXT_PATH,
      "-p",
      "say mock token",
      "--provider",
      "commandcode",
      "--model",
      CLAUDE_TEST_MODEL,
      "--thinking",
      "high",
    ],
    30_000,
  )
  assert.equal(claudePrint.code, 0, claudePrint.stderr)
  assert.match(claudePrint.stdout, /mock-pi-ok/)
  assert.equal(requestCount, 1)
  assert.equal(lastRequestBody?.model, CLAUDE_TEST_MODEL)
  assert.equal(lastRequestBody?.thinking?.type, "adaptive")
  assert.deepEqual(lastRequestBody?.output_config, { effort: "high" })
  assert.equal(lastRequestHeaders["x-api-key"], "mock-key")
  assert.equal(lastRequestHeaders["x-cmd-zdr"], "1")

  console.log("[pi-local] runtime commands through real RPC extension lifecycle")
  includeRefreshedModel = false
  const runtimeCommands = await runRpcExtensionCommands()
  assert.ok(runtimeCommands.commandNames.includes("commandcode-refresh"))
  assert.ok(runtimeCommands.commandNames.includes("commandcode-status"))
  assert.match(runtimeCommands.statusBefore, /source: live/)
  assert.match(runtimeCommands.refreshNotification, /4 models from live/)
  assert.match(runtimeCommands.statusAfter, /model count: 4/)
  assert.doesNotMatch(
    `${runtimeCommands.statusBefore}\n${runtimeCommands.statusAfter}\n${runtimeCommands.stderr}`,
    /mock-key/,
  )

  console.log("[pi-local] RPC prompt through real extension and mock API")
  requestCount = 0
  const rpc = await runRpcQuery()
  assert.equal(
    rpc.ok,
    true,
    JSON.stringify(
      { stderr: rpc.stderr, stdout: rpc.stdout, events: rpc.events.slice(-10) },
      null,
      2,
    ),
  )
  assert.equal(rpc.sawPromptAccepted, true)
  assert.equal(rpc.sawAssistantMessage, true)
  assert.equal(rpc.sawTextDelta, true)
  assert.equal(requestCount, 1)

  console.log("[pi-local] forward image input through the documented provider schema")
  requestCount = 0
  const imageRpc = await runRpcQuery(10_000, "describe image", [], {
    images: [
      {
        type: "image",
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
      },
    ],
  })
  assert.equal(imageRpc.ok, true, imageRpc.stderr)
  assert.equal(requestCount, 1)
  const imageContent = lastRequestBody?.messages?.find(
    (message) => message.role === "user",
  )?.content
  assert.ok(Array.isArray(imageContent), JSON.stringify(lastRequestBody?.messages))
  assert.ok(
    imageContent.some((part) => part.type === "image_url"),
    JSON.stringify(imageContent),
  )

  console.log("[pi-local] sibling extension streams through the pi-ai compat registry")
  requestCount = 0
  const compatCall = await runRpcCompatCall()
  assert.equal(compatCall.message, "compat-call ok: mock-pi-ok", compatCall.stderr)
  assert.equal(requestCount, 1)
  assert.equal(lastRequestBody?.model, TEST_MODEL)
  assert.ok(
    typeof lastRequestHeaders.authorization === "string" &&
      lastRequestHeaders.authorization.startsWith("Bearer "),
    "compat call should send a bearer Authorization header",
  )

  console.log("[pi-local] verify overflow normalization and compaction recovery")
  overflowMode = true
  overflowRequestCount = 0
  const overflowRpc = await runRpcOverflowRecovery()
  assert.equal(overflowRpc.ok, true)
  assert.ok(overflowRpc.requests >= 4)
  assert.equal(overflowRpc.sawCompactionRetry, true, JSON.stringify(overflowRpc))
  assert.equal(overflowRpc.stderrHasSecrets, false)
  overflowMode = false

  console.log("[pi-local] PASS")
} finally {
  await new Promise((resolve) => server.close(resolve))
  rmSync(tempHome, { recursive: true, force: true })
}
