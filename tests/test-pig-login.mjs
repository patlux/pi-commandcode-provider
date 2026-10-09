import assert from "node:assert/strict"
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isolatedHome, rpcProcess } from "./helpers/pig-process.mjs"
import { isolatedCommand } from "./helpers/isolated-command.mjs"

// Actual CLI acceptance: install, discover the auth target, validate prompted
// credentials, persist them, and reuse them in a new process. Requires patched PiG.
if (!process.env.PIG_BIN) throw new Error("PIG_BIN is required")
const packagePath =
  process.env.PIG_PACKAGE ??
  fileURLToPath(new URL("../packages/pig-commandcode-provider", import.meta.url))
const sandbox = await isolatedHome()
let calls = 0
let completions = 0
let validationStatus = 200
let child
const server = createServer((req, res) => {
  if (req.url === "/provider/v1/models") {
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "gpt-5.4", name: "GPT", context_length: 128000 }],
      }),
    )
    return
  }
  assert.equal(req.headers.authorization, "Bearer synthetic-login-key")
  if (req.url === "/alpha/whoami") {
    calls++
    res.writeHead(validationStatus, { "Content-Type": "application/json" })
    res.end("{}")
    return
  }
  assert.equal(req.url, "/provider/v1/chat/completions")
  completions++
  res.writeHead(200, { "Content-Type": "text/event-stream" })
  res.write(
    `data: ${JSON.stringify({ id: "login", choices: [{ index: 0, delta: { role: "assistant", content: "login-ok" }, finish_reason: null }] })}\n\n`,
  )
  res.write(
    `data: ${JSON.stringify({ id: "login", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  )
  res.end("data: [DONE]\n\n")
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${server.address().port}/provider/v1`
const env = { ...sandbox.env, COMMANDCODE_API_BASE: base, COMMANDCODE_MODELS_URL: `${base}/models` }
try {
  const installed = await isolatedCommand(resolve(process.env.PIG_BIN), ["install", packagePath], {
    cwd: sandbox.cwd,
    env,
  })
  assert.equal(installed.code, 0, "install must succeed before login acceptance")
  const inventory = await isolatedCommand(
    resolve(process.env.PIG_BIN),
    ["login", "--list", "--json"],
    { cwd: sandbox.cwd, env },
  )
  assert.equal(inventory.code, 0, "auth inventory must complete")
  const authPath = join(sandbox.agent, "auth.json")
  for (const status of [401, 403, 503]) {
    validationStatus = status
    const rejected = await isolatedCommand(resolve(process.env.PIG_BIN), ["login", "commandcode"], {
      cwd: sandbox.cwd,
      env,
      input: "synthetic-login-key\n",
    })
    assert.notEqual(rejected.code, 0, `HTTP ${status} validation must not succeed`)
    assert.equal(rejected.timedOut, false)
    assert.ok(!`${rejected.stdout}${rejected.stderr}`.includes("synthetic-login-key"))
    const saved = await readFile(authPath, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error
      return "{}"
    })
    assert.equal(JSON.parse(saved).commandcode, undefined, "rejected login persisted credentials")
  }
  assert.equal(calls, 3, "each rejected login must make one validation request")
  console.log("PASS actual CLI login rejects 401/403/503 without persisting or logging credentials")
  validationStatus = 200
  const login = await isolatedCommand(resolve(process.env.PIG_BIN), ["login", "commandcode"], {
    cwd: sandbox.cwd,
    env,
    input: "synthetic-login-key\n",
  })
  assert.equal(
    login.code,
    0,
    `Native CLI login acceptance failed: ${login.stderr}; inventory: ${inventory.stdout} ${inventory.stderr}`,
  )
  assert.equal(calls, 4, "login must validate the entered key")
  const saved = JSON.parse(await readFile(authPath, "utf8"))
  assert.equal(saved.commandcode.type, "oauth")
  assert.equal(saved.commandcode.access, "synthetic-login-key")
  assert.ok(!`${login.stdout}${login.stderr}`.includes("synthetic-login-key"))
  validationStatus = 401
  const rejectedReplacement = await isolatedCommand(
    resolve(process.env.PIG_BIN),
    ["login", "commandcode"],
    { cwd: sandbox.cwd, env, input: "synthetic-login-key\n" },
  )
  assert.notEqual(rejectedReplacement.code, 0)
  assert.equal(rejectedReplacement.timedOut, false)
  assert.equal(calls, 5)
  assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), saved)
  validationStatus = 200
  console.log("PASS rejected re-login leaves the previously saved credential unchanged")
  child = rpcProcess(
    resolve(process.env.PIG_BIN),
    ["--provider", "commandcode", "--model", "gpt-5.4"],
    sandbox,
    { COMMANDCODE_API_BASE: base, COMMANDCODE_MODELS_URL: `${base}/models` },
  )
  const events = await child.prompt("use saved login")
  const reply = events.findLast(
    (event) => event.type === "message_end" && event.message.role === "assistant",
  )?.message
  assert.equal(reply?.stopReason, "stop")
  assert.equal(completions, 1)
  console.log(
    "PASS actual CLI login validates, persists and reuses credentials in a subsequent process",
  )
} finally {
  try {
    if (child) await child.close()
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await sandbox.remove()
  }
}
