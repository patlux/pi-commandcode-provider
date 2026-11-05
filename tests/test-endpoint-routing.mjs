import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runContractHost } from "./host-protocol-helpers.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const extension = resolve(process.env.COMMANDCODE_TEST_PACKAGE_DIR ?? root, "index.ts")
const model = "deepseek/deepseek-v4.1-flash"
const chatOnly = "gpt-5.4"
const claude = "claude-sonnet-4-6"
const selection = process.env.COMMANDCODE_CONTRACT_HOST ?? "all"
assert.ok(["all", "pi", "omp"].includes(selection))
const hosts = (selection === "all" ? ["pi", "omp"] : [selection]).flatMap((host) => {
  const binary =
    process.env[host === "pi" ? "PI_BIN" : "OMP_BIN"] ??
    (process.env.PATH ?? "")
      .split(delimiter)
      .map((entry) => resolve(entry, host))
      .find((path) => {
        try {
          accessSync(path, constants.X_OK)
          return true
        } catch {
          return false
        }
      })
  if (binary) return [{ host, binary }]
  assert.notEqual(
    process.env[host === "pi" ? "PI_LOCAL_REQUIRED" : "OMP_COMPAT_REQUIRED"],
    "1",
    `${host} is required`,
  )
  console.log(`[endpoint-routing] SKIP ${host}: binary unavailable`)
  return []
})
let requests = [],
  wantTool = false,
  advertiseResponses = true,
  includeModel = true,
  failure
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/provider/v1/models") {
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: model,
              name: model,
              context_length: 200000,
              supported_endpoints: advertiseResponses
                ? ["/responses", "/chat/completions"]
                : ["/chat/completions"],
            },
            {
              id: chatOnly,
              name: chatOnly,
              context_length: 200000,
              supported_endpoints: ["/chat/completions"],
            },
            {
              id: claude,
              name: claude,
              context_length: 200000,
              supported_endpoints: ["/messages"],
            },
          ].filter((entry) => includeModel || entry.id !== model),
        }),
      )
      return
    }
    assert.equal(req.method, "POST")
    assert.equal(req.headers.authorization, "Bearer routing-mock-key")
    assert.ok(
      ["/provider/v1/responses", "/provider/v1/chat/completions"].includes(req.url),
      req.url,
    )
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(body.model, model)
    requests.push({ path: req.url, body })
    res.writeHead(200, { "content-type": "text/event-stream" })
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`)
    if (req.url.endsWith("/chat/completions")) {
      const toolResult = body.messages.find((message) => message.role === "tool")
      if (wantTool && !toolResult) {
        send({
          id: "routing",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                reasoning_content: "routing-private-reasoning",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_routing",
                    type: "function",
                    function: { name: "routing_ping", arguments: "{}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        send({
          id: "routing",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })
      } else {
        if (wantTool) {
          const assistant = body.messages.find((message) => message.tool_calls?.length)
          assert.equal(
            assistant?.reasoning_content ?? assistant?.reasoning,
            "routing-private-reasoning",
            "reasoning must survive forced Chat follow-up",
          )
          assert.equal(toolResult.tool_call_id, assistant.tool_calls[0].id)
          assert.match(JSON.stringify(toolResult.content), /routing-tool-result/)
        }
        send({
          id: "routing",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "routing-complete" },
              finish_reason: null,
            },
          ],
        })
        send({
          id: "routing",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })
      }
      res.end("data: [DONE]\n\n")
    } else {
      const item = {
        type: "message",
        id: "msg_routing",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "routing-complete", annotations: [] }],
      }
      send({
        type: "response.created",
        response: { id: "resp_routing", status: "in_progress", output: [] },
      })
      send({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } })
      send({
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        delta: "routing-complete",
      })
      send({ type: "response.output_item.done", output_index: 0, item })
      send({
        type: "response.completed",
        response: {
          id: "resp_routing",
          status: "completed",
          output: [item],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        },
      })
      res.end()
    }
  } catch (error) {
    failure ??= error
    if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: "Endpoint routing contract failed" } }))
  }
})
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const base = `http://127.0.0.1:${server.address().port}`
const temp = await mkdtemp(join(tmpdir(), "cc-endpoint-routing-"))
const toolExtension = join(temp, "routing-tool.ts")
await writeFile(
  toolExtension,
  `export default function (pi) {
  pi.registerTool({ name: "routing_ping", label: "Routing ping", description: "Synthetic routing test",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "routing-tool-result" }], details: undefined } }
  })
  pi.registerCommand("routing-reload-host-models", {
    description: "Reload synthetic host model overrides for routing tests",
    handler: async (_args, ctx) => {
      await ctx.modelRegistry.refresh("offline")
      await pi.setModel(ctx.modelRegistry.find("commandcode", ${JSON.stringify(model)}))
      ctx.ui.notify("routing host model config refreshed", "info")
    }
  })
}`,
)

async function rpc({ host, binary }, home, scenario) {
  let driveError,
    completed = false
  let drive = Promise.resolve()
  const args = [
    "--no-extensions",
    "--no-skills",
    "-e",
    extension,
    "-e",
    toolExtension,
    "--tools",
    "routing_ping",
    "--mode",
    "rpc",
    "--thinking",
    "high",
    ...(host === "omp"
      ? ["--no-title", "--no-rules", "--no-lsp", "--model", `commandcode/${model}`]
      : ["--provider", "commandcode", "--model", model]),
  ]
  const result = await runContractHost(binary, args, {
    label: `${host}/endpoint-routing`,
    cwd: home,
    timeoutMs: 45_000,
    env: {
      ...Object.fromEntries(
        ["PATH", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "LANG"]
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      ),
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: join(home, "sessions"),
      PI_SKIP_VERSION_CHECK: "1",
      COMMAND_CODE_API_KEY: "routing-mock-key",
      COMMANDCODE_API_KEY: "",
      COMMANDCODE_API_BASE: `${base}/provider/v1`,
      COMMANDCODE_MODELS_URL: `${base}/provider/v1/models`,
      COMMANDCODE_MODELS_CACHE: join(home, "models-cache.json"),
    },
    spawnChild: (command, commandArgs, options) => {
      const child = spawn(command, commandArgs, { ...options, stdio: ["pipe", "pipe", "pipe"] })
      const events = [],
        waiters = new Set()
      let buffer = "",
        nextId = 0
      const waitFor = (predicate, start) =>
        new Promise((done, reject) => {
          const found = events.slice(start).find(predicate)
          if (found) return done(found)
          const waiter = {
            predicate,
            done,
            reject,
            timer: setTimeout(() => {
              waiters.delete(waiter)
              reject(
                new Error(
                  `${host}: RPC routing event timeout; last events: ${JSON.stringify(events.slice(-5))}`,
                ),
              )
            }, 15_000),
          }
          waiters.add(waiter)
        })
      child.stdout.on("data", (chunk) => {
        buffer += chunk
        const lines = buffer.split("\n")
        buffer = lines.pop()
        for (const line of lines) {
          let event
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          events.push(event)
          for (const waiter of waiters)
            if (waiter.predicate(event)) {
              clearTimeout(waiter.timer)
              waiters.delete(waiter)
              waiter.done(event)
            }
        }
      })
      child.on("close", () => {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer)
          waiter.reject(new Error(`${host}: RPC closed before event`))
        }
        waiters.clear()
      })
      child.stdin.on("error", (error) => {
        driveError ??= error
      })
      const send = (value) => child.stdin.write(JSON.stringify(value) + "\n")
      const notify = async (message, pattern) => {
        const start = events.length,
          id = `routing-${++nextId}`
        send({ type: "prompt", id, message })
        const notice = await waitFor(
          (event) =>
            event.type === "extension_ui_request" &&
            event.method === "notify" &&
            pattern.test(event.message ?? ""),
          start,
        )
        const response = await waitFor(
          (event) => event.type === "response" && event.id === id,
          start,
        )
        assert.equal(response.success, true, JSON.stringify(response))
        assert.doesNotMatch(notice.message, /synthetic-private-config|routing-mock-key|Bearer/)
        return notice
      }
      const prompt = async (path, { error, warning } = {}) => {
        const start = events.length,
          count = requests.length,
          id = `routing-${++nextId}`
        send({
          type: "prompt",
          id,
          message: "Complete the routing test; use routing_ping when requested",
        })
        await waitFor((event) => event.type === "agent_end", start)
        if (failure) throw failure
        if (error) {
          assert.equal(requests.length, count, "an invalid route must not emit any POST")
          assert.match(JSON.stringify(events.slice(start)), error)
          return
        }
        if (warning) {
          assert.ok(
            events
              .slice(start)
              .some(
                (event) =>
                  event.type === "extension_ui_request" &&
                  event.method === "notify" &&
                  event.notifyType === "warning" &&
                  warning.test(event.message ?? ""),
              ),
            "routing warning must be emitted before the turn, not only by status",
          )
        }
        assert.ok(requests.length > count, `${host}: must emit a real request`)
        assert.ok(
          requests.slice(count).every((request) => request.path === path),
          JSON.stringify(requests.slice(count)),
        )
        assert.match(JSON.stringify(events.slice(start)), /routing-complete/)
      }
      // Do not await here: the synchronous spawn adapter must return the child.
      drive = Promise.resolve()
        .then(async () => {
          // Startup discovery is asynchronous; await its live/idle state, not a sleep.
          for (let attempt = 0; attempt < 40; attempt++) {
            const status = await notify("/commandcode-status", /model count:/)
            if (/source: live[\s\S]*refresh: idle/.test(status.message)) break
            assert.notEqual(attempt, 39, `${host}: catalog never became live/idle`)
            await new Promise((done) => setTimeout(done, 50))
          }
          await scenario({ notify, prompt })
          completed = true
        })
        .catch((error) => {
          driveError = error
        })
        .finally(() => {
          for (const waiter of waiters) clearTimeout(waiter.timer)
          waiters.clear()
          // runContractHost owns the deadline/escalation/close handling.
          child.stdin.end()
          if (process.platform !== "win32" && child.pid) {
            try {
              process.kill(-child.pid, "SIGTERM")
            } catch (error) {
              if (error.code !== "ESRCH") driveError ??= error
            }
          } else child.kill("SIGTERM")
        })
      return child
    },
  })
  await drive
  if (driveError) throw new Error(`${driveError.stack}\n${result.stdout}\n${result.stderr}`)
  assert.equal(completed, true, result.stdout + result.stderr)
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /synthetic-private-config|routing-mock-key|Bearer/,
  )
  if (failure) throw failure
  return result
}

try {
  for (const host of hosts) {
    const home = join(temp, host.host)
    await mkdir(home)
    const path = join(home, "commandcode-routing.json")
    const initial = JSON.stringify({ version: 1, models: { unrelated: "chat-completions" } })
    await writeFile(path, initial)
    requests = []
    failure = undefined
    wantTool = false
    await rpc(host, home, async ({ notify, prompt }) => {
      await prompt("/provider/v1/responses")
      await notify(`/commandcode-endpoint ${claude} chat-completions`, /Claude models require/)
      await notify(`/commandcode-endpoint ${chatOnly} responses`, /does not advertise Responses/)
      await notify("/commandcode-endpoint not-a-catalog-model auto", /Unknown catalog model/)
      assert.equal(await readFile(path, "utf8"), initial, "rejected choices must not write")
      await Promise.all([
        notify(
          `/commandcode-endpoint ${model} chat-completions`,
          /for deepseek\/deepseek-v4\.1-flash:/,
        ),
        notify(`/commandcode-endpoint ${chatOnly} chat-completions`, /for gpt-5\.4:/),
      ])
      assert.equal(JSON.parse(await readFile(path, "utf8")).models[chatOnly], "chat-completions")
      await notify("/commandcode-refresh", /3 models from live/)
      assert.equal(JSON.parse(await readFile(path, "utf8")).models.unrelated, "chat-completions")
      wantTool = true
      const count = requests.length
      await prompt("/provider/v1/chat/completions")
      assert.equal(requests.length - count, 2, "forced Chat must include an actual tool follow-up")
      wantTool = false
      assert.match(
        (await notify("/commandcode-status", /model endpoint:/)).message,
        /model endpoint: openai-completions.*user override/,
      )
      assert.match(
        (await notify("/commandcode-diagnostics", /^plugin:/)).message,
        /route: provider\/openai-completions/,
      )
      await notify(`/commandcode-endpoint ${model} auto`, /openai-responses.*catalog/)
      assert.equal(Object.hasOwn(JSON.parse(await readFile(path, "utf8")).models, model), false)
      await prompt("/provider/v1/responses")
      await notify(`/commandcode-endpoint ${model} responses`, /openai-responses.*user override/)
      advertiseResponses = false
      await notify("/commandcode-refresh", /3 models from live/)
      await prompt(undefined, { error: /does not advertise Responses/ })
      assert.match(
        (await notify("/commandcode-status", /model endpoint:/)).message,
        /invalid choice for the current catalog; use auto/,
      )
      await notify(`/commandcode-endpoint ${model} auto`, /openai-completions.*catalog/)
      await prompt("/provider/v1/chat/completions")
      advertiseResponses = true
      await notify("/commandcode-refresh", /3 models from live/)
      await prompt("/provider/v1/responses")
      await notify(
        `/commandcode-endpoint ${model} chat-completions`,
        /openai-completions.*user override/,
      )
    })
    await rpc(host, home, async ({ notify, prompt }) => {
      assert.match(
        (await notify("/commandcode-status", /model endpoint:/)).message,
        /openai-completions.*user override/,
      )
      await prompt("/provider/v1/chat/completions")
      includeModel = false
      await notify("/commandcode-refresh", /2 models from live/)
      const missing = await notify("/commandcode-status", /model endpoint:/)
      assert.match(
        missing.message,
        /id-rule fallback; model absent from catalog, stored choices ignored/,
      )
      assert.doesNotMatch(missing.message, /user override/)
      includeModel = true
      await notify("/commandcode-refresh", /3 models from live/)
      await prompt("/provider/v1/chat/completions")
    })
    const raw = '{"secret":"synthetic-private-config", broken'
    await writeFile(path, raw)
    const before = await stat(path)
    await rpc(host, home, async ({ notify, prompt }) => {
      const status = await notify("/commandcode-status", /using catalog routing/)
      assert.equal(status.notifyType, "warning")
      assert.match(status.message, /commandcode-routing\.json/)
      await prompt("/provider/v1/responses", { warning: /using catalog routing/ })
      assert.match(status.message, /model endpoint: openai-responses.*catalog/)
      assert.equal(await readFile(path, "utf8"), raw)
      assert.equal((await stat(path)).mtimeMs, before.mtimeMs)
      assert.equal((await readdir(home)).filter((name) => /\.bak$/.test(name)).length, 0)
      const repaired = await notify(
        `/commandcode-endpoint ${model} auto`,
        /Invalid routing choices were replaced/,
      )
      assert.equal(repaired.notifyType, "warning")
      assert.match(
        repaired.message,
        /previous contents saved as commandcode-routing\.json\.invalid-/,
      )
      const backups = (await readdir(home)).filter((name) => /\.bak$/.test(name))
      assert.equal(backups.length, 1)
      assert.equal(await readFile(join(home, backups[0]), "utf8"), raw)
      if (process.platform !== "win32")
        assert.equal((await stat(join(home, backups[0]))).mode & 0o777, 0o600)
      const after = await notify("/commandcode-status", /model endpoint:/)
      assert.doesNotMatch(after.message, /using catalog routing|stream warning:/)
      await prompt("/provider/v1/responses")
    })
    await rpc(host, home, async ({ notify, prompt }) => {
      const status = await notify("/commandcode-status", /model endpoint:/)
      assert.doesNotMatch(status.message, /using catalog routing|stream warning:/)
      assert.match(status.message, /openai-responses.*catalog/)
      await prompt("/provider/v1/responses")
    })
    if (host.host === "omp") {
      advertiseResponses = false
      await writeFile(
        join(home, "models.json"),
        JSON.stringify({
          providers: {
            commandcode: {
              modelOverrides: {
                [model]: {
                  compat: { maxTokensField: "max_completion_tokens", supportsDeveloperRole: true },
                },
              },
            },
          },
        }),
      )
      await rpc(host, home, async ({ notify, prompt }) => {
        await notify("/routing-reload-host-models", /routing host model config refreshed/)
        await prompt("/provider/v1/chat/completions")
        const body = requests.at(-1).body
        assert.equal(Object.hasOwn(body, "max_tokens"), false)
        assert.ok(body.max_completion_tokens > 0, "same-wire OMP user maxTokensField must survive")
        assert.ok(
          body.messages.some((message) => message.role === "developer"),
          "same-wire OMP user supportsDeveloperRole must survive",
        )
        assert.equal(
          Object.hasOwn(body, "commandCodeWire"),
          false,
          "private registration metadata must not become a wire field",
        )
      })
      advertiseResponses = true
      console.log("[endpoint-routing] PASS omp same-wire user compat after host model reload")
    }
    console.log(
      `[endpoint-routing] PASS ${host.host}: command + refresh + real wire + reasoning/tool follow-up + auto + restart + corrupt-file warning + explicit backed-up repair`,
    )
  }
} finally {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  await rm(temp, { recursive: true, force: true })
}
