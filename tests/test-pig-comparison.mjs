import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { isolatedCommand } from "./helpers/isolated-command.mjs"
import { isolatedHome, rpcProcess, PIG_REVISION } from "./helpers/pig-process.mjs"
import { comparisonAPI } from "./helpers/comparison-api.mjs"

if (!process.env.PIG_BIN) throw new Error("PIG_BIN is required")
const samples = process.argv.includes("--benchmark") ? 5 : 1
const patchsetSha256 = createHash("sha256")
  .update(await readFile(new URL("../patches/pig/series.json", import.meta.url)))
  .digest("hex")
const expectedPigBuild = `${PIG_REVISION.slice(0, 12)}+commandcode-${patchsetSha256.slice(0, 12)}`
const versions = {}
const contracts = JSON.parse(
  await readFile(
    new URL(
      "../packages/pig-commandcode-provider/extensions/pig-commandcode-provider/testdata/contracts.json",
      import.meta.url,
    ),
    "utf8",
  ),
)
const invalidToolContract = contracts.streams.find(
  (entry) => entry.name === "malformed arguments are not repaired or retried",
)
assert.ok(invalidToolContract)
const native = fileURLToPath(
  new URL(
    "../packages/pig-commandcode-provider/extensions/pig-commandcode-provider",
    import.meta.url,
  ),
)
const typescript = fileURLToPath(new URL("../index.ts", import.meta.url))
const api = await comparisonAPI()
const rows = []
const parityFailures = []
try {
  const hosts = [
    { name: "TS-on-PiG", binary: resolve(process.env.PIG_BIN), extension: typescript },
    { name: "Go-on-PiG", binary: resolve(process.env.PIG_BIN), extension: native },
  ]
  if (process.env.PI_BIN)
    hosts.unshift({ name: "TS-on-Pi", binary: resolve(process.env.PI_BIN), extension: typescript })
  else console.log("Pi reference not run: set PI_BIN to include the third host")
  for (const host of hosts) {
    api.setRoute("provider")
    const sandbox = await isolatedHome()
    try {
      const version = await isolatedCommand(
        host.binary,
        [host.name.endsWith("-PiG") ? "version" : "--version"],
        sandbox,
      )
      assert.equal(version.code, 0, `${host.name} version check failed`)
      versions[host.name] = version.stdout.trim()
      if (host.name.endsWith("-PiG"))
        assert.ok(
          version.stdout.includes(expectedPigBuild),
          `Build PiG with the current patchset identity: ${expectedPigBuild}; got ${version.stdout.trim()}`,
        )
      for (let sample = 0; sample < samples; sample++) {
        let processHandle
        try {
          const start = performance.now()
          processHandle = rpcProcess(
            host.binary,
            [
              "--no-extensions",
              "-e",
              host.extension,
              "--provider",
              "commandcode",
              "--model",
              "gpt-4.1",
              ...(process.argv.includes("--benchmark") ? [] : ["--thinking", "high"]),
            ],
            sandbox,
            {
              COMMANDCODE_API_BASE: api.base,
              COMMANDCODE_MODELS_URL: `${api.base}/models`,
              COMMAND_CODE_API_KEY: "synthetic-comparison-key",
            },
          )
          processHandle.send({ id: "ready", type: "get_commands" })
          await processHandle.wait((event) => event.type === "response" && event.id === "ready")
          const startupMs = performance.now() - start
          const tree = processHandle.processTree()
          if (host.name === "Go-on-PiG")
            assert.ok(!tree.some((row) => /(^|\/)node$/.test(row.command)))
          const requestStart = performance.now()
          const from = processHandle.events.length
          processHandle.send({
            id: "request",
            type: "prompt",
            message: "Say comparison-ok. Do not call tools.",
          })
          await processHandle.wait((event) => event.type === "message_update", from)
          const firstEventMs = performance.now() - requestStart
          await processHandle.wait((event) => event.type === "agent_settled", from)
          const requestMs = performance.now() - requestStart
          const message = processHandle.events
            .slice(from)
            .findLast(
              (event) => event.type === "message_end" && event.message.role === "assistant",
            )?.message
          assert.equal(message?.stopReason, "stop", JSON.stringify(message))
          assert.equal(
            message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join(""),
            "comparison-ok",
          )
          assert.equal(message.usage.input, 11)
          assert.equal(message.usage.output, 4)
          const request = api.requests.at(-1)
          assert.equal(request.path, "/provider/v1/chat/completions")
          assert.equal(request.headers.authorization, "Bearer synthetic-comparison-key")
          assert.equal(request.body.model, "gpt-4.1")
          assert.equal(request.body.stream, true)
          assert.ok(!request.body.messages.some((entry) => entry.role === "developer"))
          assert.ok(
            request.body.messages.some((entry) =>
              JSON.stringify(entry.content).includes("Say comparison-ok"),
            ),
          )
          assert.ok(request.body.tools.length > 0)
          // Keep benchmark samples matched to the original one-request profile.
          // Normal comparison also exercises the other two transport contracts.
          if (!process.argv.includes("--benchmark")) {
            const assertReply = (events) => {
              const reply = events.findLast(
                (event) => event.type === "message_end" && event.message.role === "assistant",
              )?.message
              assert.equal(reply?.stopReason, "stop", JSON.stringify(reply))
              assert.equal(
                reply.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join(""),
                "comparison-ok",
              )
              assert.equal(reply.usage.input, 11)
              assert.equal(reply.usage.output, 4)
              return reply
            }
            const readPath = resolve(sandbox.cwd, "comparison.txt")
            await writeFile(readPath, "comparison-tool-result")
            const toolRoundtrip = async () => {
              api.nextTool(readPath)
              const from = api.requests.length
              const events = await processHandle.prompt("Read the synthetic fixture once")
              assertReply(events)
              assert.equal(
                events.filter((event) => event.type === "tool_execution_end").length,
                1,
                "tool must execute once",
              )
              assert.equal(
                api.requests.length - from,
                2,
                "one tool request plus one result request",
              )
              assert.ok(JSON.stringify(api.requests.at(-1).body).includes("comparison-tool-result"))
            }
            await toolRoundtrip()
            api.signedThinking(true)
            processHandle.send({
              id: "anthropic",
              type: "set_model",
              provider: "commandcode",
              modelId: "claude-sonnet-4-6",
            })
            assert.equal(
              (
                await processHandle.wait(
                  (event) => event.type === "response" && event.id === "anthropic",
                )
              ).success,
              true,
            )
            processHandle.send({ id: "enable-thinking", type: "set_thinking_level", level: "high" })
            assert.equal(
              (
                await processHandle.wait(
                  (event) => event.type === "response" && event.id === "enable-thinking",
                )
              ).success,
              true,
            )
            const signedReply = assertReply(await processHandle.prompt("Say comparison-ok again"))
            assert.ok(
              signedReply.content.some(
                (block) =>
                  block.type === "thinking" && block.thinkingSignature === "comparison-signature",
              ),
              `${host.name}: signature already missing from first response`,
            )
            const anthropic = api.requests.at(-1)
            assert.equal(
              new URL(anthropic.path, "http://127.0.0.1").pathname,
              "/provider/v1/messages",
            )
            console.log(`${host.name} Anthropic request URL: ${anthropic.path}`)
            assert.equal(anthropic.headers["anthropic-version"], "2023-06-01")
            assert.ok(anthropic.body.tools.every((tool) => tool.input_schema?.type === "object"))
            assert.ok(anthropic.body.messages.some((entry) => entry.role === "assistant"))
            assertReply(await processHandle.prompt("Continue signed reasoning"))
            const blocks = api.requests
              .at(-1)
              .body.messages.flatMap((entry) => (Array.isArray(entry.content) ? entry.content : []))
            if (
              !blocks.some(
                (block) => block.type === "thinking" && block.signature === "comparison-signature",
              )
            )
              parityFailures.push(
                `${host.name}: signed Anthropic reasoning is missing from second-turn request (first response api=${signedReply.api}, thinkingLevel=${signedReply.thinkingLevel ?? "unset"})`,
              )
            api.signedThinking(false)
            processHandle.send({
              id: "openai",
              type: "set_model",
              provider: "commandcode",
              modelId: "gpt-4.1",
            })
            assert.equal(
              (
                await processHandle.wait(
                  (event) => event.type === "response" && event.id === "openai",
                )
              ).success,
              true,
            )
            api.setRoute("upgrade")
            const fallbackFrom = api.requests.length
            assertReply(await processHandle.prompt("Say comparison-ok through fallback"))
            assert.deepEqual(
              api.requests.slice(fallbackFrom).map((entry) => entry.path),
              ["/provider/v1/chat/completions", "/alpha/generate"],
            )
            const generated = api.requests.at(-1)
            assert.equal(generated.body.params.max_tokens, 64000)
            assert.equal(generated.headers.authorization, "Bearer synthetic-comparison-key")
            assert.equal(generated.headers["x-command-code-version"], "1.66.0")
            assert.ok(
              generated.body.params.tools.every((tool) => tool.input_schema?.type === "object"),
            )
            const rememberedFrom = api.requests.length
            assertReply(await processHandle.prompt("Say comparison-ok using remembered route"))
            assert.deepEqual(
              api.requests.slice(rememberedFrom).map((entry) => entry.path),
              ["/alpha/generate"],
            )
            await toolRoundtrip()
            api.nextGenerateEvents(invalidToolContract.events)
            const invalidFrom = api.requests.length
            const invalidEvents = await processHandle.prompt(
              "Check a malformed synthetic tool call",
            )
            const invalidReply = invalidEvents.findLast(
              (event) => event.type === "message_end" && event.message.role === "assistant",
            )?.message
            assert.equal(invalidReply?.stopReason, invalidToolContract.expected.reason)
            assert.ok(
              invalidReply.errorMessage.includes(invalidToolContract.expected.errorContains),
            )
            assert.equal(
              invalidEvents.filter((event) => event.type === "tool_execution_start").length,
              0,
            )
            assert.equal(api.requests.length - invalidFrom, 1, "invalid tool call must not retry")
            assertReply(await processHandle.prompt("Recover after the malformed tool call"))
            console.log(
              `${host.name}: shared invalid-tool contract rejected without execution/retry; recovery passed`,
            )
            api.setRoute("provider")
          }
          assert.deepEqual(await processHandle.close(), { code: 0, signal: null })
          const shutdownMs = processHandle.shutdownDurationMs()
          processHandle = null
          rows.push({
            host: host.name,
            sample,
            extensionCache: sample === 0 ? "cold (shared Go module/build cache)" : "warm",
            startupMs,
            firstEventMs,
            requestMs,
            aggregateRssKiB: tree.reduce((sum, row) => sum + row.rssKiB, 0),
            processes: tree.length,
            shutdownMs,
            maxTokens: request.body.max_tokens,
            toolCount: request.body.tools.length,
          })
        } finally {
          if (processHandle) await processHandle.close()
        }
      }
    } finally {
      await sandbox.remove()
    }
  }
  console.log(
    JSON.stringify(
      {
        pigRevision: PIG_REVISION,
        patchsetSha256,
        versions,
        platform: process.platform,
        arch: process.arch,
        note: "Sequential synthetic samples. RSS includes host descendants; it is sampled, not peak RSS. First compile/load is separate from warm samples. Tool sets and host prompts may differ and are reported, not normalized away.",
        samples: rows,
        parityFailures,
      },
      null,
      2,
    ),
  )
  assert.deepEqual(parityFailures, [], "semantic host parity is not complete")
} finally {
  await api.close()
}
