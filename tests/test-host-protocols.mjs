import assert from "node:assert/strict"
import { accessSync, constants } from "node:fs"
import { createServer } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CONTRACT_IMAGES,
  CONTRACT_MODELS,
  assertToolImages,
  assertSystemInstructions,
  runContractHost,
} from "./host-protocol-helpers.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const extension = resolve(process.env.COMMANDCODE_TEST_PACKAGE_DIR ?? root, "index.ts")
const fixture = join(root, "tests/fixtures/protocol-tools-extension.ts")
const models = CONTRACT_MODELS
const thinking = "high"
const selection = process.env.COMMANDCODE_CONTRACT_HOST ?? "all"
assert.ok(
  ["all", "pi", "omp"].includes(selection),
  "COMMANDCODE_CONTRACT_HOST must be all, pi or omp",
)
const hosts = (selection === "all" ? ["pi", "omp"] : [selection]).flatMap((host) => {
  const explicit = process.env[host === "pi" ? "PI_BIN" : "OMP_BIN"]
  const binary =
    explicit ??
    (process.env.PATH ?? "")
      .split(delimiter)
      .map((entry) => resolve(entry, host))
      .find((candidate) => {
        try {
          accessSync(candidate, constants.X_OK)
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
  console.log(`[host-contract] SKIP ${host}: binary unavailable`)
  return []
})
let active
let bodies = []
let failure
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname
    if (req.method === "GET" && path === "/provider/v1/models") {
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          object: "list",
          data: models.map(({ id, wire }) => ({
            id,
            name: id,
            context_length: 200000,
            supported_endpoints: [`/${wire}`],
          })),
        }),
      )
      return
    }
    assert.equal(path, `/provider/v1/${active.wire}`)
    assert.equal(
      req.headers.authorization ?? req.headers["x-api-key"],
      req.headers.authorization ? "Bearer contract-key" : "contract-key",
    )
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    bodies.push(body)
    assert.equal(body.model, active.id)
    assertSystemInstructions(body, active.wire)
    assert.ok(
      body.tools.some((tool) => (tool.function?.name ?? tool.name) === "contract_read"),
      JSON.stringify(body.tools.map((tool) => tool.function?.name ?? tool.name)),
    )
    const first = bodies.length === 1
    if (!first) {
      const history = JSON.stringify(body.messages ?? body.input)
      assert.match(history, /contract-result-A/)
      assert.match(history, /contract-result-B/)
      assertToolImages(body, active.wire)
      // Both tool calls and results must survive, including parallel image results.
      if (active.wire === "chat/completions") {
        const assistant = body.messages.find((message) => message.tool_calls?.length === 2)
        assert.ok(assistant)
        assert.equal(
          assistant.reasoning_content ?? assistant.reasoning,
          "contract-private-reasoning",
          JSON.stringify(assistant),
        )
        const results = body.messages.filter((message) => message.role === "tool")
        assert.deepEqual(
          results.map((result) => result.tool_call_id).sort(),
          assistant.tool_calls.map((call) => call.id).sort(),
        )
        for (const call of assistant.tool_calls) {
          const label = JSON.parse(call.function.arguments).image
          const result = results.find((item) => item.tool_call_id === call.id)
          assert.equal(result.content, `contract-result-${label}`)
        }
      } else if (active.wire === "responses") {
        assert.ok(
          body.input.some(
            (item) => item.type === "reasoning" && item.encrypted_content === "contract-encrypted",
          ),
        )
        const calls = body.input.filter((item) => item.type === "function_call")
        const results = body.input.filter((item) => item.type === "function_call_output")
        assert.equal(calls.length, 2)
        assert.deepEqual(
          calls.map((call) => call.call_id).sort(),
          ["call_contract_A", "call_contract_B"],
          "Responses call IDs must survive without their long item-ID suffix",
        )
        assert.deepEqual(
          results.map((item) => item.call_id).sort(),
          calls.map((item) => item.call_id).sort(),
        )
        for (const call of calls) {
          const label = JSON.parse(call.arguments).image
          const result = results.find((item) => item.call_id === call.call_id)
          assert.ok(result.output.some((part) => part.text === `contract-result-${label}`))
        }
      } else {
        assert.ok(
          body.messages
            .flatMap((message) => message.content ?? [])
            .some(
              (part) =>
                part.type === "thinking" &&
                part.thinking === "contract-private-reasoning" &&
                part.signature === "contract-signature",
            ),
        )
        const calls = body.messages
          .flatMap((message) => message.content ?? [])
          .filter((part) => part.type === "tool_use")
        const results = body.messages
          .flatMap((message) => message.content ?? [])
          .filter((part) => part.type === "tool_result")
        assert.equal(calls.length, 2)
        assert.deepEqual(
          results.map((part) => part.tool_use_id).sort(),
          calls.map((part) => part.id).sort(),
        )
        for (const call of calls) {
          const result = results.find((part) => part.tool_use_id === call.id)
          assert.ok(
            result.content.some((part) => part.text === `contract-result-${call.input.image}`),
          )
        }
      }
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const send = (data) =>
      res.write(
        `${active.wire === "messages" ? `event: ${data.type}\n` : ""}data: ${JSON.stringify(data)}\n\n`,
      )
    const calls = ["A", "B"].map((image, index) => ({
      id: `call_contract_${image}`,
      name: "contract_read",
      arguments: JSON.stringify({ image }),
      index,
    }))
    if (active.wire === "chat/completions") {
      send({
        id: "contract",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: first
              ? {
                  role: "assistant",
                  reasoning_content: "contract-private-reasoning",
                  tool_calls: calls.map((call) => ({
                    index: call.index,
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }
              : { role: "assistant", content: "contract-complete" },
            finish_reason: null,
          },
        ],
      })
      send({
        id: "contract",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      })
      res.end("data: [DONE]\n\n")
    } else if (active.wire === "responses") {
      send({
        type: "response.created",
        response: { id: "resp_contract", status: "in_progress", output: [] },
      })
      if (first) {
        const item = {
          type: "reasoning",
          id: "rs_contract",
          encrypted_content: "contract-encrypted",
          summary: [{ type: "summary_text", text: "contract-private-reasoning" }],
        }
        send({
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, summary: [] },
        })
        send({
          type: "response.reasoning_summary_text.delta",
          output_index: 0,
          item_id: item.id,
          summary_index: 0,
          delta: "contract-private-reasoning",
        })
        send({ type: "response.output_item.done", output_index: 0, item })
      }
      const output = first
        ? calls.map((call) => ({
            type: "function_call",
            // Hosts combine call_id|item_id internally. A long item_id must not
            // leak into the replayed call_id; raw long API call_ids are not
            // constrained here (the separate generate path owns #141's limit).
            id: `fc_contract_${call.index}_${"x".repeat(80)}`,
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
            status: "completed",
          }))
        : [
            {
              type: "message",
              id: "msg_contract",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "contract-complete", annotations: [] }],
            },
          ]
      for (const [position, item] of output.entries()) {
        const index = position + (first ? 1 : 0)
        send({
          type: "response.output_item.added",
          output_index: index,
          item: { ...item, arguments: first ? "" : undefined, content: first ? undefined : [] },
        })
        if (first)
          send({
            type: "response.function_call_arguments.delta",
            output_index: index,
            item_id: item.id,
            delta: item.arguments,
          })
        else
          send({
            type: "response.output_text.delta",
            output_index: index,
            item_id: item.id,
            content_index: 0,
            delta: "contract-complete",
          })
        send({ type: "response.output_item.done", output_index: index, item })
      }
      send({
        type: "response.completed",
        response: {
          id: "resp_contract",
          status: "completed",
          output,
          usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
        },
      })
      res.end()
    } else {
      send({
        type: "message_start",
        message: {
          id: "msg_contract",
          type: "message",
          role: "assistant",
          model: active.id,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      })
      if (first) {
        send({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        })
        send({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "contract-private-reasoning" },
        })
        send({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "contract-signature" },
        })
        send({ type: "content_block_stop", index: 0 })
      }
      const content = first
        ? calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: {} }))
        : [{ type: "text", text: "" }]
      for (const [position, part] of content.entries()) {
        const index = position + (first ? 1 : 0)
        send({ type: "content_block_start", index, content_block: part })
        send({
          type: "content_block_delta",
          index,
          delta: first
            ? { type: "input_json_delta", partial_json: calls[position].arguments }
            : { type: "text_delta", text: "contract-complete" },
        })
        send({ type: "content_block_stop", index })
      }
      send({
        type: "message_delta",
        delta: { stop_reason: first ? "tool_use" : "end_turn" },
        usage: { output_tokens: 5 },
      })
      send({ type: "message_stop" })
      res.end()
    }
  } catch (error) {
    failure ??= error
    res.writeHead(400, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        error: { message: "Contract assertion failed", type: "invalid_request_error" },
      }),
    )
  }
})
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
const base = `http://127.0.0.1:${server.address().port}`
const temp = await mkdtemp(join(tmpdir(), "cc-host-contracts-"))
try {
  // Static imports are generated against the tested package, not this checkout
  // when COMMANDCODE_TEST_PACKAGE_DIR selects an installed artifact.
  const toolsExtension = join(temp, "contract-tools.ts")
  await writeFile(
    toolsExtension,
    `import assert from "node:assert/strict"
import registerTools from ${JSON.stringify(fixture)}
import { MODEL_REASONING, MODEL_EFFORTS, inputModalitiesForModel, apiForModelId } from ${JSON.stringify(resolve(process.env.COMMANDCODE_TEST_PACKAGE_DIR ?? root, "src/models.ts"))}
export default function (pi) {
  for (const { id, wire, api } of ${JSON.stringify(models)}) {
    assert.equal(MODEL_REASONING[id], true, id + ": contract requires catalog reasoning")
    assert.ok(MODEL_EFFORTS[id]?.includes(${JSON.stringify(thinking)}), id + ": contract requires supported thinking effort")
    assert.ok(inputModalitiesForModel(id).includes("image"), id + ": contract requires catalog image input")
    assert.equal(apiForModelId(id, ["/" + wire]), api, id + ": contract routing precondition changed")
  }
  registerTools(pi, ${JSON.stringify(CONTRACT_IMAGES)})
  console.log("[host-contract] catalog preconditions PASS")
}
`,
  )
  for (const { host, binary } of hosts) {
    for (const model of models) {
      active = model
      bodies = []
      failure = undefined
      const home = join(temp, host, model.wire.replaceAll("/", "-"))
      await mkdir(home, { recursive: true })
      const args =
        host === "omp"
          ? [
              "-e",
              extension,
              "-e",
              toolsExtension,
              "--no-title",
              "--no-extensions",
              "--no-skills",
              "--no-rules",
              "--no-lsp",
              "--tools",
              "contract_read",
              "-p",
              "Read A and B using contract_read",
              "--model",
              `commandcode/${model.id}`,
            ]
          : [
              "--no-extensions",
              "--no-skills",
              "--tools",
              "contract_read",
              "-e",
              extension,
              "-e",
              toolsExtension,
              "-p",
              "Read A and B using contract_read",
              "--provider",
              "commandcode",
              "--model",
              model.id,
            ]
      const result = await runContractHost(
        binary,
        [...args, "--system-prompt", "contract-system-sentinel", "--thinking", thinking],
        {
          label: `${host}/${model.wire}`,
          cwd: home,
          env: {
            // Only OS/tool discovery variables cross into the mock-only host.
            ...Object.fromEntries(
              ["PATH", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "LANG"]
                .filter((key) => process.env[key] !== undefined)
                .map((key) => [key, process.env[key]]),
            ),
            PI_SKIP_VERSION_CHECK: "1",
            HOME: home,
            USERPROFILE: home,
            PI_CODING_AGENT_DIR: home,
            PI_CODING_AGENT_SESSION_DIR: join(home, "sessions"),
            COMMAND_CODE_API_KEY: "contract-key",
            COMMANDCODE_API_KEY: "",
            COMMANDCODE_API_BASE: `${base}/provider/v1`,
            COMMANDCODE_MODELS_URL: `${base}/provider/v1/models`,
            COMMANDCODE_MODELS_CACHE: join(home, "models-cache.json"),
          },
        },
      )
      if (failure) throw new Error(`${failure.message}\n${result.stdout}\n${result.stderr}`)
      assert.equal(result.code, 0, result.stdout + result.stderr)
      assert.match(
        result.stdout + result.stderr,
        /\[host-contract\] catalog preconditions PASS/,
        result.stderr,
      )
      assert.match(result.stdout, /contract-complete/, result.stderr)
      assert.equal(bodies.length, 2)
      console.log(
        `[host-contract] PASS ${host} ${model.wire}: reasoning + system + parallel tools + images + follow-up history`,
      )
    }
  }
} finally {
  server.closeAllConnections()
  await new Promise((resolveClose) => server.close(resolveClose))
  await rm(temp, { recursive: true, force: true })
}
