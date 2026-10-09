import assert from "node:assert/strict"
import { createServer } from "node:http"
import { realpath } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isolatedHome, rpcProcess } from "./helpers/pig-process.mjs"

const binary = process.env.PIG_BIN
if (!binary)
  throw new Error("PIG_BIN must point to the pinned PiG build; this required test never skips")
const extension =
  process.env.PIG_EXTENSION ??
  fileURLToPath(
    new URL(
      "../packages/pig-commandcode-provider/extensions/pig-commandcode-provider",
      import.meta.url,
    ),
  )
const requests = []
let mode = "provider"
let disconnected
let toolSerial = 0
let pendingToolId
let failureStatus
let failedRequests = 0
let offlineCatalog = false
let signedThinking = false
let expectedKey = "synthetic-pig-key"
let liveMarker = false
function observeDisconnect(response) {
  disconnected = new Promise((resolve) => response.once("close", resolve))
}
async function assertDisconnected() {
  assert.ok(disconnected, "slow request did not register its disconnect observer")
  let timer
  try {
    await Promise.race([
      disconnected,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("aborted request stayed connected")), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString()
  requests.push({ path: req.url, headers: req.headers, body: body ? JSON.parse(body) : null })
  if (req.url === "/provider/v1/models") {
    if (offlineCatalog) {
      res.writeHead(503)
      res.end("offline")
      return
    }
    res.setHeader("Content-Type", "application/json")
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "gpt-5.4", name: "GPT 5.4", context_length: 128000 },
          { id: "claude-sonnet-4-6", name: "Claude Sonnet", context_length: 200000 },
        ],
      }),
    )
    return
  }
  if (req.url === "/alpha/whoami") {
    res.end(JSON.stringify({ org: { id: "test-org", login: "test-account" } }))
    return
  }
  if (req.url.startsWith("/alpha/billing/credits")) {
    res.writeHead(503)
    res.end("unavailable")
    return
  }
  if (req.url.startsWith("/alpha/billing/subscriptions")) {
    res.end(JSON.stringify({ data: { planId: "go", status: "active" } }))
    return
  }
  if (req.url.startsWith("/alpha/usage/summary")) {
    res.end(JSON.stringify({ totalCost: 2, totalCount: 4 }))
    return
  }
  assert.equal(
    req.headers.authorization ?? `Bearer ${req.headers["x-api-key"]}`,
    `Bearer ${expectedKey}`,
  )
  assert.equal(req.headers["x-cmd-zdr"], "1", "provider ZDR header must reach both transports")
  if (mode === "upgrade" && !req.url.startsWith("/alpha/generate")) {
    res.writeHead(403, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: { code: "upgrade_required" } }))
    return
  }
  if (failureStatus) {
    failedRequests++
    res.writeHead(failureStatus, { "Content-Type": "application/json", "Retry-After": "0" })
    res.end(
      JSON.stringify({
        error: {
          code: failureStatus === 400 ? "context_length_exceeded" : "test_failure",
          message:
            failureStatus === 400
              ? "prompt too long"
              : "synthetic failure Bearer synthetic-pig-key",
        },
      }),
    )
    failureStatus = undefined
    return
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" })
  const event = (value) =>
    res.write(
      `${req.url.startsWith("/provider/v1/messages") ? `event: ${value.type}\n` : ""}data: ${JSON.stringify(value)}\n\n`,
    )
  if (mode === "invalid-tool") {
    assert.equal(req.url, "/alpha/generate")
    event({ type: "tool-input-start", id: "invalid-tool", toolName: "count_test" })
    event({
      type: "tool-input-delta",
      id: "invalid-tool",
      delta: '{"value":"must-not-run"',
    })
    event({
      type: "tool-call",
      toolCallId: "invalid-tool",
      toolName: "count_test",
      input: '{"value":"must-not-run"',
    })
    event({ type: "finish", finishReason: "tool-calls" })
    // A broken provider response must end the turn, not start a tool/retry loop.
    mode = "provider"
    res.end()
    return
  }
  if (mode === "tool") {
    const payload = JSON.parse(body)
    const messages = payload.params?.messages ?? payload.messages
    if (pendingToolId) {
      assert.ok(
        JSON.stringify(messages).includes(`counted:${pendingToolId}`),
        "tool result did not reach provider",
      )
      pendingToolId = undefined
      mode = "provider"
    } else {
      pendingToolId = `tool-${++toolSerial}`
      if (req.url === "/alpha/generate") {
        event({ type: "tool-input-start", id: pendingToolId, toolName: "count_test" })
        event({ type: "tool-input-delta", id: pendingToolId, delta: '{"value":' })
        event({
          type: "tool-input-delta",
          id: pendingToolId,
          delta: JSON.stringify(pendingToolId) + "}",
        })
        event({
          type: "tool-call",
          toolCallId: pendingToolId,
          toolName: "count_test",
          input: { value: pendingToolId },
        })
        // A repeated upstream terminal must not schedule the tool twice.
        event({
          type: "tool-call",
          toolCallId: pendingToolId,
          toolName: "count_test",
          input: { value: pendingToolId },
        })
        event({
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 10, outputTokens: 3 },
        })
      } else {
        event({
          id: "tool",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: pendingToolId,
                    type: "function",
                    function: { name: "count_test", arguments: '{"value":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        event({
          id: "tool",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: JSON.stringify(pendingToolId) + "}" } },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        event({
          id: "tool",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        })
      }
      res.end()
      return
    }
  }
  if (req.url === "/alpha/generate") {
    event({ type: "reasoning-delta", text: "synthetic thought" })
    event({ type: "reasoning-end" })
    event({ type: "text-delta", text: "generate-ok" })
    if (mode === "slow-generate") {
      observeDisconnect(res)
      return
    }
    event({
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 10, outputTokens: 3 },
    })
    res.end()
  } else if (req.url.startsWith("/provider/v1/messages")) {
    event({
      type: "message_start",
      message: {
        id: "m",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    })
    assert.equal(req.headers["anthropic-version"], "2023-06-01")
    if (signedThinking) {
      event({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      })
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "signed thought" },
      })
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "synthetic-signature" },
      })
      event({ type: "content_block_stop", index: 0 })
    }
    const textIndex = signedThinking ? 1 : 0
    event({
      type: "content_block_start",
      index: textIndex,
      content_block: { type: "text", text: "" },
    })
    event({
      type: "content_block_delta",
      index: textIndex,
      delta: { type: "text_delta", text: "anthropic-ok" },
    })
    event({ type: "content_block_stop", index: textIndex })
    event({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3 },
    })
    event({ type: "message_stop" })
    res.end()
  } else {
    assert.equal(req.url, "/provider/v1/chat/completions")
    event({
      id: "m",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: liveMarker ? "native-live-ok" : "openai-ok" },
          finish_reason: null,
        },
      ],
    })
    if (mode === "slow") {
      observeDisconnect(res)
      return
    }
    event({
      id: "m",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    })
    res.end("data: [DONE]\n\n")
  }
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${server.address().port}`
const sandbox = await isolatedHome()
let processHandle
const endMessage = (events) =>
  events.findLast((event) => event.type === "message_end" && event.message.role === "assistant")
    ?.message
try {
  processHandle = rpcProcess(
    resolve(binary),
    [
      "--no-extensions",
      "-e",
      extension,
      "-e",
      fileURLToPath(new URL("./fixtures/pig-sibling", import.meta.url)),
      "-e",
      fileURLToPath(new URL("./fixtures/pig-live-driver", import.meta.url)),
      "--provider",
      "commandcode",
      "--model",
      "gpt-5.4",
    ],
    sandbox,
    {
      COMMANDCODE_API_BASE: `${base}/provider/v1`,
      COMMANDCODE_MODELS_URL: `${base}/provider/v1/models`,
      COMMAND_CODE_API_KEY: "synthetic-pig-key",
      COMMANDCODE_ZDR: "1",
    },
  )
  let message = endMessage(await processHandle.prompt("hello"))
  assert.equal(message?.stopReason, "stop", JSON.stringify(message))
  assert.equal(message.content[0].text, "openai-ok")
  assert.equal(message.api, "commandcode-custom")
  assert.ok(
    !processHandle.processTree().some((process) => /(^|\/)node$/.test(process.command)),
    "native provider spawned a Node runtime",
  )
  console.log("PASS native OpenAI streaming without a Node subprocess")

  const from = processHandle.events.length
  processHandle.send({
    id: "anthropic",
    type: "set_model",
    provider: "commandcode",
    modelId: "claude-sonnet-4-6",
  })
  const selected = await processHandle.wait(
    (event) => event.type === "response" && event.id === "anthropic",
    from,
  )
  assert.equal(selected.success, true)
  message = endMessage(await processHandle.prompt("hello anthropic"))
  assert.equal(message?.stopReason, "stop", JSON.stringify(message))
  assert.equal(message.content[0].text, "anthropic-ok")
  signedThinking = true
  message = endMessage(await processHandle.prompt("signed thinking turn"))
  assert.equal(
    message.content.find((block) => block.type === "thinking")?.thinkingSignature,
    "synthetic-signature",
  )
  assert.equal(endMessage(await processHandle.prompt("reuse signed thinking")).stopReason, "stop")
  const replay = requests
    .at(-1)
    .body.messages.flatMap((entry) => (Array.isArray(entry.content) ? entry.content : []))
  assert.ok(
    replay.some(
      (block) =>
        block.type === "thinking" &&
        block.signature === "synthetic-signature" &&
        block.thinking === "signed thought",
    ),
  )
  signedThinking = false
  console.log("PASS native Anthropic headers and signed reasoning preserved across real turns")

  processHandle.send({
    id: "openai",
    type: "set_model",
    provider: "commandcode",
    modelId: "gpt-5.4",
  })
  await processHandle.wait((event) => event.type === "response" && event.id === "openai")
  mode = "slow"
  const abortFrom = processHandle.events.length
  processHandle.send({ id: "slow", type: "prompt", message: "slow" })
  await processHandle.wait((event) => event.type === "message_update", abortFrom)
  processHandle.send({ id: "abort", type: "abort" })
  await processHandle.wait((event) => event.type === "agent_settled", abortFrom)
  assert.equal(endMessage(processHandle.events.slice(abortFrom)).stopReason, "aborted")
  await assertDisconnected()
  mode = "provider"
  assert.equal(endMessage(await processHandle.prompt("after abort")).stopReason, "stop")
  console.log("PASS abort closes HTTP and session remains usable")

  mode = "tool"
  assert.equal(endMessage(await processHandle.prompt("call count_test"))?.stopReason, "stop")
  let effects = await processHandle.command("/test-count")
  assert.ok(effects.some((event) => event.message === '{"toolCalls":1}'))
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
  const imageFrom = processHandle.events.length
  processHandle.send({
    id: "image",
    type: "prompt",
    message: "inspect image",
    images: [{ type: "image", data: image, mimeType: "image/png" }],
  })
  await processHandle.wait((event) => event.type === "agent_settled", imageFrom)
  assert.equal(endMessage(processHandle.events.slice(imageFrom)).stopReason, "stop")
  assert.ok(
    JSON.stringify(requests.at(-1).body).includes("data:image/png;base64,"),
    JSON.stringify(requests.at(-1).body.messages.slice(-2)),
  )
  assert.ok(
    requests
      .at(-1)
      .body.messages.some(
        (entry) =>
          Array.isArray(entry.content) && entry.content.some((part) => part.type === "image_url"),
      ),
  )
  console.log("PASS fragmented tool roundtrip (one effect) and valid image payload")

  failureStatus = 403
  const beforeForbidden = requests.length
  message = endMessage(await processHandle.prompt("forbidden once"))
  assert.equal(message.stopReason, "error")
  assert.ok(!JSON.stringify(message).includes("synthetic-pig-key"))
  assert.ok(!requests.slice(beforeForbidden).some((request) => request.path === "/alpha/generate"))
  assert.equal(endMessage(await processHandle.prompt("recover forbidden")).stopReason, "stop")
  for (const code of [429, 500]) {
    failureStatus = code
    const countBefore = failedRequests
    message = endMessage(await processHandle.prompt(`recover ${code}`))
    assert.equal(message.stopReason, "stop", JSON.stringify(message))
    assert.equal(failedRequests, countBefore + 1)
  }
  effects = await processHandle.command("/test-count")
  assert.ok(effects.some((event) => event.message === '{"toolCalls":1}'))
  console.log(
    "PASS exact non-upgrade error, redaction and rate/server recovery without repeated tool effects",
  )

  mode = "upgrade"
  message = endMessage(await processHandle.prompt("use fallback"))
  assert.equal(message?.stopReason, "stop", JSON.stringify(message))
  assert.equal(message.content.find((block) => block.type === "text").text, "generate-ok")
  assert.equal(message.usage.input, 10)
  const providerCount = requests.filter(
    (request) => request.path === "/provider/v1/chat/completions",
  ).length
  message = endMessage(await processHandle.prompt("remember fallback"))
  assert.equal(message.stopReason, "stop")
  assert.equal(
    requests.filter((request) => request.path === "/provider/v1/chat/completions").length,
    providerCount,
  )
  mode = "slow-generate"
  disconnected = undefined
  const generateAbortFrom = processHandle.events.length
  processHandle.send({ id: "generate-slow", type: "prompt", message: "slow generate" })
  await processHandle.wait(
    (event) =>
      event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta",
    generateAbortFrom,
  )
  processHandle.send({ id: "generate-abort", type: "abort" })
  await processHandle.wait((event) => event.type === "agent_settled", generateAbortFrom)
  assert.equal(endMessage(processHandle.events.slice(generateAbortFrom)).stopReason, "aborted")
  await assertDisconnected()
  mode = "provider"
  assert.equal(
    endMessage(await processHandle.prompt("reuse after generate abort")).stopReason,
    "stop",
  )
  console.log("PASS generate abort disconnect and subsequent session reuse")
  failureStatus = 400
  message = endMessage(await processHandle.prompt("overflow once"))
  assert.equal(message.stopReason, "error", JSON.stringify(message))
  assert.match(message.errorMessage, /context_length_exceeded/)
  assert.equal(endMessage(await processHandle.prompt("recover after overflow")).stopReason, "stop")
  const generate = requests.find((request) => request.path === "/alpha/generate")
  assert.equal(generate.body.params.model, "gpt-5.4")
  assert.ok(generate.body.params.system.length > 0)
  assert.ok(generate.body.params.tools.length > 0)
  assert.equal(generate.headers["x-command-code-version"], "1.66.0")
  assert.equal(
    generate.headers["x-project-slug"],
    (await realpath(sandbox.cwd))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
  )
  assert.equal(generate.body.params.max_tokens, 64000)
  console.log("PASS real generate protocol, usage and remembered exact fallback")

  mode = "tool"
  assert.equal(endMessage(await processHandle.prompt("generate tool roundtrip")).stopReason, "stop")
  effects = await processHandle.command("/test-count")
  assert.ok(effects.some((event) => event.message === '{"toolCalls":2}'))
  const generatedTool = requests.filter((request) => request.path === "/alpha/generate").at(-1)
  assert.ok(JSON.stringify(generatedTool.body.params.messages).includes('"type":"tool-result"'))
  assert.ok(JSON.stringify(generatedTool.body.params.messages).includes('"type":"image"'))
  console.log("PASS generate tool result/image history and exactly one additional tool effect")
  mode = "invalid-tool"
  const beforeInvalidTool = requests.length
  const invalidToolEvents = await processHandle.prompt("reject malformed generate tool arguments")
  message = endMessage(invalidToolEvents)
  assert.equal(message.stopReason, "error", JSON.stringify(message))
  assert.match(message.errorMessage, /tool call arguments/)
  assert.ok(
    !invalidToolEvents.some(
      (event) =>
        event.type === "tool_execution_start" ||
        event.assistantMessageEvent?.type === "toolcall_end",
    ),
    "malformed arguments reached tool completion or execution",
  )
  assert.equal(requests.length, beforeInvalidTool + 1, "malformed tool call was replayed")
  effects = await processHandle.command("/test-count")
  assert.ok(effects.some((event) => event.message === '{"toolCalls":2}'))
  assert.equal(
    endMessage(await processHandle.prompt("recover after malformed tool arguments")).stopReason,
    "stop",
  )
  console.log("PASS malformed generate tool arguments fail without execution/retry and recover")
  const beforeReplay = requests.length
  const replayResult = await processHandle.command("/test-failed-history")
  assert.ok(replayResult.some((event) => event.message === "failed-history-ok"))
  const replayRequests = requests.slice(beforeReplay)
  assert.equal(replayRequests.length, 2)
  for (const request of replayRequests) {
    assert.equal(request.path, "/alpha/generate")
    const messages = JSON.stringify(request.body.params.messages)
    assert.ok(messages.includes("synthetic-replay-check"))
    assert.ok(messages.includes("recover"))
    assert.ok(!messages.includes("failed-"), "failed turn leaked through registry replay")
  }
  console.log("PASS sibling registry calls omit failed/aborted history and orphan tool results")
  expectedKey = "synthetic-rotated-key"
  const rotation = await processHandle.command("/test-key-change")
  assert.ok(rotation.some((event) => event.message === "key-change-ok"))
  assert.equal(
    requests.at(-1).path,
    "/provider/v1/chat/completions",
    "key change retained previous fallback route",
  )
  assert.equal(requests.at(-1).headers["x-test-option"], "forwarded")
  assert.equal(requests.at(-1).body.max_tokens, 100)
  assert.equal(requests.at(-1).body.temperature, 0)
  expectedKey = "synthetic-pig-key"
  mode = "upgrade"
  assert.equal(endMessage(await processHandle.prompt("return to original key")).stopReason, "stop")
  console.log("PASS request credential change resets fallback and preserves options/headers")
  const sibling = await processHandle.command("/test-sibling")
  assert.ok(sibling.some((event) => event.message === "sibling-ok"))
  const loginFrom = processHandle.events.length
  const login = processHandle.command("/test-login")
  const prompt = await processHandle.wait(
    (event) => event.type === "extension_ui_request" && event.method === "input",
    loginFrom,
  )
  processHandle.send({ type: "extension_ui_response", id: prompt.id, value: "synthetic-pig-key" })
  assert.ok((await login).some((event) => event.message === "login-validated-ok"))
  assert.equal(requests.filter((request) => request.path === "/alpha/whoami").length, 1)
  console.log("PASS sibling extension streaming and actual prompted login validation")
  const hooks = await processHandle.command("/test-hooks")
  const hookEvent = hooks.find(
    (event) => event.type === "extension_ui_request" && event.method === "notify",
  )
  const { counts, rawKinds, responses } = JSON.parse(hookEvent.message)
  assert.ok(counts.before_provider_request > 0)
  assert.ok(counts.after_provider_response > 0, "native response hook must be forwarded")
  assert.ok(counts.provider_stream_event > 0, "native raw stream hook must be forwarded")
  assert.ok(rawKinds["openai-choices"] > 0, "OpenAI raw payload must reach observer")
  assert.ok(rawKinds.message_start > 0, "Anthropic raw payload must reach observer")
  assert.ok(rawKinds["text-delta"] > 0, "Generate raw payload must reach observer")
  assert.ok(responses.ok > 0, "response status must reach observer")
  console.log("Observed native host hooks", counts, rawKinds)
  await processHandle.command("/commandcode-refresh")
  const status = await processHandle.command("/commandcode-status")
  assert.ok(status.some((event) => event.message?.includes?.("Transport: generate")))
  const quota = await processHandle.command("/commandcode-quota")
  assert.ok(
    quota.some(
      (event) =>
        event.message?.includes?.("Credits: unavailable") &&
        event.message.includes("Subscription: go active") &&
        event.message.includes("Usage: $2.0000"),
    ),
  )
  offlineCatalog = true
  await processHandle.command("/commandcode-refresh")
  const offline = await processHandle.command("/commandcode-status")
  assert.ok(
    offline.some(
      (event) =>
        event.message?.includes?.("2 models (live)") && event.message.includes("catalog retained"),
    ),
  )
  offlineCatalog = false
  await processHandle.command("/test-reload")
  mode = "provider"
  assert.equal(endMessage(await processHandle.prompt("after reload")).stopReason, "stop")
  const reloaded = await processHandle.command("/commandcode-status")
  assert.equal(
    reloaded.filter((event) => event.message?.includes?.("Transport: provider")).length,
    1,
  )
  console.log("PASS quota partial failure, offline refresh, reload and continued streaming")
  liveMarker = true
  const bounded = await processHandle.command("/test-live gpt-5.4")
  assert.ok(bounded.some((event) => event.message === "bounded-live-ok"))
  const boundedRequest = requests.findLast(
    (request) => request.path === "/provider/v1/chat/completions",
  )
  assert.equal(boundedRequest.body.max_tokens, 64)
  assert.equal(boundedRequest.body.tools?.length ?? 0, 0)
  console.log("PASS optional live-profile driver tested against mock only (64 tokens, no tools)")
  assert.deepEqual(await processHandle.close(), { code: 0, signal: null })
  processHandle = null
  console.log("PASS status command and clean RPC EOF shutdown")
  console.log(
    `Verified ${requests.length} loopback requests; isolated cache ${join(sandbox.agent, "commandcode-models.json")}`,
  )
} finally {
  try {
    if (processHandle) await processHandle.close()
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await sandbox.remove()
  }
}
