import assert from "node:assert/strict"
import { createServer } from "node:http"
import { writeFile, mkdir, rm, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isolatedHome, rpcProcess } from "./helpers/pig-process.mjs"

if (!process.env.PIG_BIN) throw new Error("PIG_BIN is required")
const extension =
  process.env.PIG_EXTENSION ??
  fileURLToPath(
    new URL(
      "../packages/pig-commandcode-provider/extensions/pig-commandcode-provider",
      import.meta.url,
    ),
  )
const sandbox = await isolatedHome()
const observed = []
let discovery = "live"
let catalogRequests = 0
let discoveryEntered
let discoveryClosed
let overflowAt = -1
const server = createServer(async (req, res) => {
  if (req.url === "/provider/v1/models") {
    catalogRequests++
    assert.equal(req.headers.authorization, undefined)
    if (discovery === "offline") {
      res.writeHead(503)
      res.end("unavailable")
      return
    }
    if (discovery === "malformed") {
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "gpt-4.1", name: "Must not be published", context_length: 128000 }],
        }) + "trailing garbage",
      )
      return
    }
    if (discovery === "slow") {
      res.on("close", () => discoveryClosed?.())
      discoveryEntered?.()
      return
    }
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "gpt-5.4", name: "GPT", context_length: 128000 }],
      }),
    )
    return
  }
  if (req.url === "/alpha/whoami") {
    assert.equal(req.headers.authorization, "Bearer synthetic-login-key")
    res.end("{}")
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  observed.push({
    key: req.headers.authorization,
    body: JSON.parse(Buffer.concat(chunks).toString()),
  })
  if (observed.length === overflowAt) {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        error: { code: "context_length_exceeded", message: "Input exceeds context limit" },
      }),
    )
    return
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" })
  res.write(
    `data: ${JSON.stringify({ id: "state", choices: [{ index: 0, delta: { role: "assistant", content: "state-ok" }, finish_reason: null }] })}\n\n`,
  )
  res.write(
    `data: ${JSON.stringify({ id: "state", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  )
  res.end("data: [DONE]\n\n")
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${server.address().port}/provider/v1`
const cache = join(sandbox.agent, "commandcode-models.json")
let child
function launch(extra = {}, args = [], selectModel = true) {
  return rpcProcess(
    resolve(process.env.PIG_BIN),
    [
      "--no-extensions",
      "-e",
      extension,
      ...(selectModel ? ["--provider", "commandcode", "--model", "gpt-5.4"] : []),
      ...args,
    ],
    sandbox,
    {
      COMMANDCODE_API_BASE: base,
      COMMANDCODE_MODELS_URL: `${base}/models`,
      COMMANDCODE_MODELS_TIMEOUT_MS: "500",
      ...extra,
    },
  )
}
const terminal = (events) =>
  events.findLast((event) => event.type === "message_end" && event.message.role === "assistant")
    ?.message
async function removeCredentials() {
  for (const path of [
    join(sandbox.agent, "auth.json"),
    join(sandbox.home, ".commandcode"),
    join(sandbox.home, ".pi"),
    join(sandbox.home, ".omp"),
  ])
    await rm(path, { recursive: true, force: true })
}
async function credentialFile(path, value) {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
}
try {
  const cases = [
    {
      name: "primary env wins legacy",
      env: { COMMAND_CODE_API_KEY: "primary", COMMANDCODE_API_KEY: "legacy" },
      expected: "primary",
    },
    { name: "legacy env", env: { COMMANDCODE_API_KEY: "legacy" }, expected: "legacy" },
    {
      name: "stored API key",
      path: join(sandbox.agent, "auth.json"),
      auth: { commandcode: { type: "api_key", key: "stored" } },
      expected: "stored",
    },
    {
      name: "stored OAuth",
      path: join(sandbox.agent, "auth.json"),
      auth: {
        commandcode: { type: "oauth", access: "oauth", refresh: "oauth", expires: 4102444800000 },
      },
      expected: "oauth",
    },
    { name: "CLI key", args: ["--api-key", "cli-synthetic"], expected: "cli-synthetic" },
    {
      name: "Command Code CLI file",
      path: join(sandbox.home, ".commandcode/auth.json"),
      auth: { apiKey: "cc-file" },
      expected: "cc-file",
    },
    {
      name: "Pi compatibility file",
      path: join(sandbox.home, ".pi/agent/auth.json"),
      auth: { commandcode: { type: "api_key", key: "pi-file" } },
      expected: "pi-file",
    },
    {
      name: "OMP compatibility file",
      path: join(sandbox.home, ".omp/agent/auth.json"),
      auth: { "command-code": { type: "oauth", access: "omp-file" } },
      expected: "omp-file",
    },
    {
      name: "host credential beats environment",
      path: join(sandbox.agent, "auth.json"),
      auth: { commandcode: { type: "api_key", key: "stored-priority" } },
      env: { COMMAND_CODE_API_KEY: "environment" },
      expected: "stored-priority",
    },
  ]
  for (const scenario of cases) {
    await removeCredentials()
    if (scenario.path) await credentialFile(scenario.path, scenario.auth)
    child = launch(scenario.env, scenario.args)
    const message = terminal(await child.prompt("synthetic auth request"))
    assert.equal(message?.stopReason, "stop", `${scenario.name}: ${JSON.stringify(message)}`)
    assert.equal(observed.at(-1).key, `Bearer ${scenario.expected}`, scenario.name)
    assert.deepEqual(await child.close(), { code: 0, signal: null })
    child = null
    console.log(`PASS ${scenario.name}`)
  }
  // The standalone CLI login acceptance gate is separate: test-pig-login.mjs.
  // It requires the patched host. Do not count prewritten OAuth credentials
  // above as successful login/persistence evidence.
  await removeCredentials()
  const count = observed.length
  child = launch({ COMMAND_CODE_API_KEY: "$COMMAND_CODE_API_KEY" })
  child.send({ id: "missing", type: "prompt", message: "must not send" })
  const rejection = await child.wait(
    (event) =>
      (event.type === "response" && event.id === "missing" && !event.success) ||
      (event.type === "message_end" && event.message.stopReason === "error"),
  )
  assert.ok(JSON.stringify(rejection).match(/API key|credential|auth/i))
  assert.equal(observed.length, count)
  await child.close()
  child = null
  console.log("PASS missing/placeholder key makes no model request")

  discovery = "offline"
  child = launch({ COMMAND_CODE_API_KEY: "offline" })
  assert.equal(terminal(await child.prompt("offline catalog request")).stopReason, "stop")
  await child.close()
  child = null
  console.log("PASS cached catalog works during discovery outage")

  await rm(cache)
  child = launch({ COMMAND_CODE_API_KEY: "recovery" }, [], false)
  const unavailable = await child.command("/commandcode-status")
  assert.ok(unavailable.some((event) => event.message?.includes?.("0 models (empty)")))
  discovery = "live"
  await child.command("/commandcode-refresh")
  const published = JSON.parse(await readFile(cache, "utf8"))
  assert.equal(published.models[0].id, "gpt-5.4")
  child.send({
    id: "recover-model",
    type: "set_model",
    provider: "commandcode",
    modelId: "gpt-5.4",
  })
  assert.equal(
    (await child.wait((event) => event.type === "response" && event.id === "recover-model"))
      .success,
    true,
  )
  assert.equal(terminal(await child.prompt("recovered cold catalog")).stopReason, "stop")
  await child.close()
  child = null
  console.log("PASS empty offline start recovers via refresh and publishes models")

  child = launch({ COMMAND_CODE_API_KEY: "catalog-retention" })
  await child.command("/commandcode-refresh")
  const validCache = await readFile(cache, "utf8")
  discovery = "malformed"
  await child.command("/commandcode-refresh")
  assert.equal(await readFile(cache, "utf8"), validCache, "malformed catalog replaced cache")
  let retained = await child.command("/commandcode-status")
  assert.ok(
    retained.some(
      (event) =>
        event.message?.includes?.("1 models (live)") && event.message.includes("catalog retained"),
    ),
  )
  // Simulate an older cache left by another process or a failed cache write.
  await writeFile(
    cache,
    JSON.stringify({
      version: 1,
      models: [{ id: "gpt-4.1", name: "Stale disk model", contextWindow: 128000 }],
    }),
  )
  discovery = "offline"
  await child.command("/commandcode-refresh")
  child.send({
    id: "retained-model",
    type: "set_model",
    provider: "commandcode",
    modelId: "gpt-5.4",
  })
  assert.equal(
    (await child.wait((event) => event.type === "response" && event.id === "retained-model"))
      .success,
    true,
    "failed refresh rolled live registry back to stale disk catalog",
  )
  assert.equal(terminal(await child.prompt("use retained live catalog")).stopReason, "stop")
  assert.equal(observed.at(-1).body.model, "gpt-5.4")
  discovery = "live"
  await child.command("/commandcode-refresh")
  retained = await child.command("/commandcode-status")
  assert.ok(retained.some((event) => event.message?.includes?.("1 models (live)")))
  assert.ok(!retained.some((event) => event.message?.includes?.("Could not refresh")))
  assert.equal(JSON.parse(await readFile(cache, "utf8")).models[0].id, "gpt-5.4")
  await child.close()
  child = null
  console.log(
    "PASS malformed catalog rejected, stale cache cannot roll back live state, refresh recovers",
  )

  await writeFile(
    join(sandbox.agent, "settings.json"),
    JSON.stringify({
      packages: [],
      compaction: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
    }),
  )
  child = launch({ COMMAND_CODE_API_KEY: "overflow" })
  assert.equal(
    terminal(await child.prompt("synthetic history for compaction ".repeat(100))).stopReason,
    "stop",
  )
  assert.equal(
    terminal(await child.prompt("second retained turn before overflow")).stopReason,
    "stop",
  )
  overflowAt = observed.length + 1
  const recovered = await child.prompt("overflow and compact")
  assert.equal(
    terminal(recovered).stopReason,
    "stop",
    JSON.stringify(recovered.filter((event) => event.type !== "message_update")),
  )
  assert.ok(
    recovered.some(
      (event) => event.type === "compaction_end" && event.reason === "overflow" && event.willRetry,
    ),
    "host did not compact and retry overflow",
  )
  assert.ok(observed.length >= overflowAt + 2, "expected summary and retry requests")
  await child.close()
  child = null
  overflowAt = -1
  console.log("PASS actual host overflow compaction and automatic retry")

  discovery = "slow"
  const entered = new Promise((resolve) => {
    discoveryEntered = resolve
  })
  const closed = new Promise((resolve) => {
    discoveryClosed = resolve
  })
  child = launch({ COMMAND_CODE_API_KEY: "slow", COMMANDCODE_MODELS_TIMEOUT_MS: "60000" })
  const before = catalogRequests
  let enteredTimer
  try {
    await Promise.race([
      entered,
      new Promise((_, reject) => {
        enteredTimer = setTimeout(
          () => reject(new Error("background discovery did not start")),
          120_000,
        )
      }),
    ])
  } finally {
    clearTimeout(enteredTimer)
  }
  const ready = await child.command("/commandcode-status")
  assert.ok(ready.some((event) => event.message?.includes?.("1 models (cache)")))
  assert.equal(catalogRequests, before + 1)
  assert.deepEqual(await child.close(), { code: 0, signal: null })
  child = null
  let closedTimer
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        closedTimer = setTimeout(
          () => reject(new Error("background discovery did not disconnect")),
          5000,
        )
      }),
    ])
  } finally {
    clearTimeout(closedTimer)
  }
  console.log("PASS warm startup does not await slow network; shutdown cancels background refresh")
} finally {
  try {
    if (child) await child.close()
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await sandbox.remove()
  }
}
