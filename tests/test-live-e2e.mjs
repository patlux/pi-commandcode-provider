#!/usr/bin/env node
/**
 * Live end-to-end validation against Command Code with existing credentials.
 *
 * This test never reads or prints credential files. Pi resolves authentication
 * through its normal provider flow. It is intentionally excluded from `npm test`
 * because it consumes live provider capacity.
 */

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const extensionPath = join(projectDir, "index.ts")
const testModel = process.env.COMMANDCODE_E2E_MODEL ?? "deepseek/deepseek-v4-flash"
const testProfile = process.env.COMMANDCODE_E2E_PROFILE
if (testProfile && !["goat", "provider"].includes(testProfile)) {
  throw new Error("Live profiles require Provider API access; Go is not supported")
}
const expectedTransport = "provider"
const expectedPlan = testProfile
// GPT-5.6 Luna is available on every plan and has a ZDR-capable upstream;
// Gemini 3.7 Flash currently fails with a zero-data-retention routing 404.
const goatVisionModel = process.env.COMMANDCODE_E2E_GOAT_VISION_MODEL ?? "gpt-5.6-luna"
const marker = "commandcode-live-e2e-ok"

function findPiBinary() {
  if (process.env.PI_BIN) return process.env.PI_BIN
  const localBin = resolve(projectDir, "node_modules", ".bin")
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(entry, "pi")
    if (candidate.startsWith(localBin)) continue
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined
}

function hasAuthMetadata() {
  return (
    Boolean(process.env.COMMAND_CODE_API_KEY) ||
    Boolean(process.env.COMMANDCODE_API_KEY) ||
    existsSync(join(homedir(), ".commandcode", "auth.json")) ||
    existsSync(join(homedir(), ".pi", "agent", "auth.json"))
  )
}

const piBin = findPiBinary()
if (!piBin || !hasAuthMetadata()) {
  console.log("[live-e2e] SKIP — pi or Command Code auth metadata unavailable")
  process.exit(0)
}

const profileAgentDir = testProfile
  ? mkdtempSync(join(tmpdir(), `pi-commandcode-live-${testProfile}-agent-`))
  : undefined

function safeEnv(overrides = {}) {
  const env = { ...process.env, PI_SKIP_VERSION_CHECK: "1", ...overrides }
  if (testProfile && profileAgentDir) {
    env.PI_CODING_AGENT_DIR = profileAgentDir
    env.COMMANDCODE_MODELS_CACHE = join(profileAgentDir, "commandcode-models.json")
  } else {
    delete env.COMMAND_CODE_API_KEY
    delete env.COMMANDCODE_API_KEY
  }
  return env
}

function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180_000
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectDir,
      env: options.env ?? safeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: -1, stdout, stderr: `${stderr}\nTIMEOUT after ${timeoutMs}ms` })
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

async function runRpc(extension, action, timeoutMs = 120_000, model = testModel) {
  const child = spawn(
    piBin,
    [
      "--no-extensions",
      "--mode",
      "rpc",
      "-e",
      extension,
      "--provider",
      "commandcode",
      "--model",
      model,
      "--thinking",
      "high",
    ],
    { cwd: projectDir, env: safeEnv(), stdio: ["pipe", "pipe", "pipe"] },
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
    new Promise((resolveWait, reject) => {
      const existing = events.find(predicate)
      if (existing) {
        resolveWait(existing)
        return
      }
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error(`RPC timeout. stderr: ${stderr.slice(-500)}`))
      }, timeoutMs)
      waiters.push({ predicate, resolve: resolveWait, timer })
    })
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`)

  try {
    return await action({ send, waitFor, events, getStderr: () => stderr })
  } finally {
    child.kill()
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "pi-commandcode-live-e2e-"))
try {
  console.log("[live-e2e] live reasoning request")
  const reasoning = await run(
    piBin,
    [
      "--no-extensions",
      "-e",
      extensionPath,
      "--no-session",
      "-p",
      "--provider",
      "commandcode",
      "--model",
      testModel,
      "--thinking",
      "high",
      `Reply exactly: ${marker}`,
    ],
    { timeoutMs: 180_000 },
  )
  assert.equal(reasoning.code, 0, reasoning.stderr)
  assert.match(reasoning.stdout, new RegExp(marker))

  console.log("[live-e2e] live multi-turn reasoning history")
  const multiTurn = await runRpc(extensionPath, async ({ send, waitFor, events, getStderr }) => {
    const countThinkingDeltas = (startIndex) =>
      events
        .slice(startIndex)
        .filter(
          (event) =>
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "thinking_delta" &&
            typeof event.assistantMessageEvent.delta === "string" &&
            event.assistantMessageEvent.delta.length > 0,
        ).length

    const firstStart = events.length
    send({
      id: "reasoning-turn-1",
      type: "prompt",
      message:
        "Reason step by step before answering. Calculate 37 * 41, then reply with only the number.",
    })
    await waitFor(
      (event) => event.type === "response" && event.id === "reasoning-turn-1" && event.success,
    )
    const firstSettled = await waitFor(
      (event) => event.type === "agent_settled" && events.indexOf(event) >= firstStart,
    )
    const firstSettledIndex = events.indexOf(firstSettled)
    const firstThinkingDeltas = events
      .slice(firstStart, firstSettledIndex + 1)
      .filter(
        (event) =>
          event.type === "message_update" &&
          event.assistantMessageEvent?.type === "thinking_delta" &&
          typeof event.assistantMessageEvent.delta === "string" &&
          event.assistantMessageEvent.delta.length > 0,
      ).length

    const secondStart = events.length
    send({
      id: "reasoning-turn-2",
      type: "prompt",
      message:
        "Now reason step by step again. Add 19 to your previous numeric result, then reply with only the number.",
    })
    await waitFor(
      (event) => event.type === "response" && event.id === "reasoning-turn-2" && event.success,
    )
    const secondSettled = await waitFor(
      (event) => event.type === "agent_settled" && events.indexOf(event) >= secondStart,
    )
    const secondThinkingDeltas = countThinkingDeltas(secondStart)
    assert.ok(events.indexOf(secondSettled) >= secondStart)

    return { firstThinkingDeltas, secondThinkingDeltas, stderr: getStderr() }
  })
  assert.ok(multiTurn.firstThinkingDeltas > 0, "first turn should stream reasoning")
  assert.ok(multiTurn.secondThinkingDeltas > 0, "follow-up turn should stream fresh reasoning")
  assert.doesNotMatch(multiTurn.stderr, /Bearer\s+\S+/i)

  console.log("[live-e2e] live runtime refresh/status commands")
  const runtime = await runRpc(extensionPath, async ({ send, waitFor, getStderr }) => {
    if (expectedTransport) {
      send({ id: "transport-probe", type: "prompt", message: `Reply exactly: ${marker}` })
      await waitFor(
        (event) => event.type === "response" && event.id === "transport-probe" && event.success,
      )
      await waitFor((event) => event.type === "agent_settled")
    }

    send({ id: "commands", type: "get_commands" })
    const commands = await waitFor(
      (event) => event.type === "response" && event.id === "commands" && event.success,
    )
    const names = commands.data?.commands?.map((command) => command.name) ?? []

    send({ id: "refresh", type: "prompt", message: "/commandcode-refresh" })
    await waitFor((event) => event.type === "response" && event.id === "refresh" && event.success)
    const refresh = await waitFor(
      (event) =>
        event.type === "extension_ui_request" &&
        event.method === "notify" &&
        typeof event.message === "string" &&
        event.message.includes("model catalog"),
    )

    send({ id: "status", type: "prompt", message: "/commandcode-status" })
    await waitFor((event) => event.type === "response" && event.id === "status" && event.success)
    const status = await waitFor(
      (event) =>
        event.type === "extension_ui_request" &&
        event.method === "notify" &&
        typeof event.message === "string" &&
        event.message.includes("source:"),
    )

    send({ id: "quota", type: "prompt", message: "/commandcode-quota" })
    await waitFor((event) => event.type === "response" && event.id === "quota" && event.success)
    const quota = await waitFor(
      (event) =>
        event.type === "extension_ui_request" &&
        event.method === "notify" &&
        typeof event.message === "string" &&
        event.message.includes("Plan:"),
    )
    return {
      names,
      refresh: refresh.message,
      status: status.message,
      quota: quota.message,
      stderr: getStderr(),
    }
  })
  assert.ok(runtime.names.includes("commandcode-refresh"))
  assert.ok(runtime.names.includes("commandcode-status"))
  assert.ok(runtime.names.includes("commandcode-quota"))
  assert.match(runtime.refresh, /model catalog (?:refreshed|unchanged)/)
  if (expectedTransport) assert.match(runtime.status, new RegExp(`transport: ${expectedTransport}`))
  assert.match(runtime.status, /source: (?:live|cache)/)
  assert.match(runtime.status, /model count: [1-9][0-9]*/)
  if (expectedPlan) assert.match(runtime.quota, new RegExp(`Plan:.*\\b${expectedPlan}\\b`, "i"))
  assert.doesNotMatch(
    `${runtime.refresh}\n${runtime.status}\n${runtime.quota}\n${runtime.stderr}`,
    /Bearer\s+\S+/i,
  )

  console.log("[live-e2e] live abort through real RPC host")
  const abortResult = await runRpc(extensionPath, async ({ send, waitFor, events, getStderr }) => {
    const startIndex = events.length
    send({
      id: "abort-turn",
      type: "prompt",
      message: "Write a very long detailed explanation of every integer from 1 to 10000.",
    })
    await waitFor(
      (event) => event.type === "response" && event.id === "abort-turn" && event.success,
    )
    await waitFor((event) => event.type === "message_update" && events.indexOf(event) >= startIndex)
    send({ id: "abort", type: "abort" })
    await waitFor((event) => event.type === "response" && event.id === "abort" && event.success)
    await waitFor((event) => event.type === "agent_settled" && events.indexOf(event) >= startIndex)
    return {
      aborted: events
        .slice(startIndex)
        .some(
          (event) =>
            event.type === "message_end" &&
            event.message?.role === "assistant" &&
            event.message?.stopReason === "aborted",
        ),
      stderr: getStderr(),
    }
  })
  assert.equal(abortResult.aborted, true)
  assert.doesNotMatch(abortResult.stderr, /Bearer\s+\S+/i)

  console.log("[live-e2e] live tool-call round trip")
  const toolRoot = join(tempRoot, "tool-roundtrip")
  const targetPath = join(toolRoot, "commandcode-e2e.txt")
  const toolPrompt = [
    `Use the write tool to create ${targetPath}.`,
    `The file content must be exactly ${marker}.`,
    `After the tool succeeds, reply exactly: ${marker}`,
  ].join(" ")
  const toolResult = await run(
    piBin,
    [
      "--no-extensions",
      "-e",
      extensionPath,
      "--no-session",
      "-p",
      "--provider",
      "commandcode",
      "--model",
      testModel,
      toolPrompt,
    ],
    { cwd: tempRoot, timeoutMs: 180_000 },
  )
  assert.equal(toolResult.code, 0, toolResult.stderr)
  assert.match(toolResult.stdout, new RegExp(marker))
  assert.equal(readFileSync(targetPath, "utf-8").trimEnd(), marker)

  if (testProfile === "goat") {
    console.log("[live-e2e] live vision request through Provider API")
    const vision = await runRpc(
      extensionPath,
      async ({ send, waitFor, events, getStderr }) => {
        const startIndex = events.length
        send({
          id: "vision",
          type: "prompt",
          message: "Describe the attached image briefly.",
          images: [
            {
              type: "image",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              mimeType: "image/png",
            },
          ],
        })
        await waitFor(
          (event) => event.type === "response" && event.id === "vision" && event.success,
        )
        await waitFor(
          (event) => event.type === "agent_settled" && events.indexOf(event) >= startIndex,
        )
        const messageEnd = events
          .slice(startIndex)
          .find((event) => event.type === "message_end" && event.message?.role === "assistant")
        return { messageEnd, stderr: getStderr() }
      },
      180_000,
      goatVisionModel,
    )
    assert.notEqual(vision.messageEnd?.message?.stopReason, "error")
    assert.doesNotMatch(vision.stderr, /Bearer\s+\S+/i)
  }

  console.log("[live-e2e] packed artifact with existing authentication")
  const packDir = join(tempRoot, "pack")
  mkdirSync(packDir, { recursive: true })
  const pack = await run("npm", ["pack", "--pack-destination", packDir, "--silent"], {
    timeoutMs: 120_000,
  })
  assert.equal(pack.code, 0, pack.stderr)
  const tarballName = pack.stdout.trim().split("\n").at(-1)
  assert.ok(tarballName)
  const tarball = join(packDir, tarballName)
  const appDir = join(tempRoot, "packed-app")
  const install = await run(
    "npm",
    ["install", "--prefix", appDir, "--ignore-scripts", "--no-save", tarball],
    { timeoutMs: 180_000 },
  )
  assert.equal(install.code, 0, install.stderr)
  const packedExtension = join(appDir, "node_modules", "pi-commandcode-provider", "index.ts")
  const packedLive = await run(
    piBin,
    [
      "--no-extensions",
      "-e",
      packedExtension,
      "--no-session",
      "-p",
      "--provider",
      "commandcode",
      "--model",
      testModel,
      `Reply exactly: ${marker}`,
    ],
    { timeoutMs: 180_000 },
  )
  assert.equal(packedLive.code, 0, packedLive.stderr)
  assert.match(packedLive.stdout, new RegExp(marker))

  console.log("[live-e2e] PASS")
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
  if (profileAgentDir) rmSync(profileAgentDir, { recursive: true, force: true })
}
