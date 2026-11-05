import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { spawn } from "node:child_process"
import { test } from "node:test"
import {
  CONTRACT_IMAGES,
  assertToolImages,
  assertSystemInstructions,
  runContractHost,
} from "./host-protocol-helpers.mjs"

const url = (data) => `data:image/png;base64,${data}`
function request(wire) {
  const results = Object.entries(CONTRACT_IMAGES).map(([label, data]) => {
    const text = {
      type: wire === "responses" ? "input_text" : "text",
      text: `contract-result-${label}`,
    }
    if (wire === "responses")
      return {
        type: "function_call_output",
        call_id: label,
        output: [text, { type: "input_image", image_url: url(data) }],
      }
    return {
      type: "tool_result",
      tool_use_id: label,
      content: [text, { type: "image", source: { type: "base64", media_type: "image/png", data } }],
    }
  })
  if (wire === "responses") return { input: results }
  if (wire === "messages") return { messages: [{ role: "user", content: results }] }
  return {
    messages: [
      // Even embedding payloads in call arguments must not satisfy image checks.
      {
        role: "assistant",
        tool_calls: [{ function: { arguments: JSON.stringify(CONTRACT_IMAGES) } }],
      },
      {
        role: "user",
        content: Object.values(CONTRACT_IMAGES).map((data) => ({
          type: "image_url",
          image_url: { url: url(data) },
        })),
      },
    ],
  }
}
function imageParts(body, wire) {
  if (wire === "chat/completions") return [body.messages[1].content]
  if (wire === "responses") return body.input.map((item) => item.output)
  return body.messages[0].content.map((item) => item.content)
}

for (const wire of ["chat/completions", "responses", "messages"]) {
  test(`${wire}: accept two distinct typed image payloads`, () => {
    assertToolImages(request(wire), wire)
  })
  test(`${wire}: reject missing images, even with image arguments/text`, () => {
    const body = request(wire)
    for (const parts of imageParts(body, wire)) {
      for (let i = parts.length - 1; i >= 0; i--)
        if (["image_url", "input_image", "image"].includes(parts[i].type)) parts.splice(i, 1)
      parts.push({ type: "text", text: JSON.stringify(CONTRACT_IMAGES) })
    }
    assert.throws(() => assertToolImages(body, wire))
  })
  test(`${wire}: reject a duplicated payload instead of the second image`, () => {
    const body = request(wire)
    const parts = imageParts(body, wire).flat()
    for (const part of parts) {
      if (part.type === "image_url") part.image_url.url = url(CONTRACT_IMAGES.A)
      if (part.type === "input_image") part.image_url = url(CONTRACT_IMAGES.A)
      if (part.type === "image") part.source.data = CONTRACT_IMAGES.A
    }
    assert.throws(() => assertToolImages(body, wire))
  })
  test(`${wire}: reject payloads in text parts instead of images`, () => {
    const body = request(wire)
    for (const part of imageParts(body, wire).flat())
      if (["image_url", "input_image", "image"].includes(part.type)) part.type = "text"
    assert.throws(() => assertToolImages(body, wire))
  })
  if (wire !== "chat/completions") {
    test(`${wire}: reject images swapped between tool results`, () => {
      const body = request(wire)
      const [a, b] = imageParts(body, wire)
      ;[a[1], b[1]] = [b[1], a[1]]
      assert.throws(() => assertToolImages(body, wire))
    })
  }
}

for (const wire of ["chat/completions", "responses", "messages"]) {
  test(`${wire}: system sentinel in user text alone cannot satisfy instructions`, () => {
    const history = [{ role: "user", content: "contract-system-sentinel" }]
    const body = wire === "responses" ? { input: history } : { messages: history }
    assert.throws(() => assertSystemInstructions(body, wire), /system instructions/)
  })
  test(`${wire}: accept the system sentinel in its native system field`, () => {
    const system = [{ role: "system", content: "contract-system-sentinel" }]
    const body =
      wire === "responses"
        ? { input: system }
        : wire === "messages"
          ? { system: [{ type: "text", text: "contract-system-sentinel" }] }
          : { messages: system }
    assertSystemInstructions(body, wire)
  })
}
test("Responses: accept the OMP instructions field without a system input item", () => {
  assertSystemInstructions({ instructions: "contract-system-sentinel", input: [] }, "responses")
})

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

test("host timeout waits for close, captures late output and cannot become success", async () => {
  const child = fakeChild()
  let killed
  const term = new Promise((resolve) => {
    killed = resolve
  })
  child.kill = (signal) => {
    killed(signal)
    return true
  }
  const outcome = runContractHost("fake", [], {
    label: "timeout",
    timeoutMs: 1,
    spawnChild: () => child,
  })
  let settled = false
  const rejected = assert.rejects(
    outcome.finally(() => {
      settled = true
    }),
    /timed out: timeout[\s\S]*late-output/,
  )
  try {
    assert.equal(await term, "SIGTERM")
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    child.stdout.emit("data", Buffer.from("late-output"))
  } finally {
    child.emit("close", 0)
  }
  await rejected
})

test("host timeout escalates when SIGTERM is ignored, then waits for close", async () => {
  const child = fakeChild()
  const signals = []
  child.kill = (signal) => {
    signals.push(signal)
    if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null))
    return true
  }
  await assert.rejects(
    runContractHost("fake", [], {
      label: "ignored-term",
      timeoutMs: 1,
      killGraceMs: 1,
      spawnChild: () => child,
    }),
    /timed out: ignored-term/,
  )
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
})

test("host normal close preserves code and output and clears timeout", async () => {
  const child = fakeChild()
  child.kill = () => assert.fail("a closed host must not be signalled")
  let options
  const outcome = runContractHost("fake", [], {
    label: "normal",
    timeoutMs: 1,
    spawnChild: (_binary, _args, opts) => {
      options = opts
      return child
    },
  })
  child.stdout.emit("data", Buffer.from("out"))
  child.stderr.emit("data", Buffer.from("err"))
  child.emit("close", 7)
  assert.deepEqual(await outcome, { code: 7, stdout: "out", stderr: "err" })
  assert.equal(options.detached, process.platform !== "win32")
  await new Promise((resolve) => setTimeout(resolve, 5))
})

test("host missing close after SIGKILL destroys pipes and rejects within its final bound", async () => {
  const child = fakeChild()
  const signals = []
  const destroyed = []
  let unreferenced = false
  child.unref = () => (unreferenced = true)
  for (const name of ["stdout", "stderr"]) child[name].destroy = () => destroyed.push(name)
  child.kill = (signal) => {
    signals.push(signal)
    return true
  }
  // Rescue the old implementation so this negative control fails, never hangs.
  const rescue = setTimeout(() => child.emit("close", null), 200)
  try {
    await assert.rejects(
      runContractHost("fake", [], {
        label: "held-pipes",
        timeoutMs: 1,
        killGraceMs: 1,
        closeGraceMs: 1,
        spawnChild: () => child,
      }),
      /timed out: held-pipes[\s\S]*stdio did not close after SIGKILL/,
    )
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
    assert.deepEqual(destroyed.sort(), ["stderr", "stdout"])
    assert.equal(unreferenced, true)
    // A late close must be harmless after final cleanup/rejection.
    child.emit("close", 0)
  } finally {
    clearTimeout(rescue)
  }
})

test("host signalling errors still reach bounded pipe cleanup", async () => {
  const child = fakeChild()
  const destroyed = []
  for (const name of ["stdout", "stderr"]) child[name].destroy = () => destroyed.push(name)
  child.kill = () => {
    throw new Error("signal denied")
  }
  await assert.rejects(
    runContractHost("fake", [], {
      label: "signal-error",
      timeoutMs: 1,
      killGraceMs: 1,
      closeGraceMs: 1,
      spawnChild: () => child,
    }),
    /timed out: signal-error[\s\S]*signal denied/,
  )
  assert.deepEqual(destroyed.sort(), ["stderr", "stdout"])
})

test(
  "POSIX host timeout signals descendants sharing inherited pipes and reaps them",
  { skip: process.platform === "win32" },
  async () => {
    const descendant = `
      process.on("SIGTERM", () => process.exit(0));
      console.log("descendant-ready:" + process.pid);
      setTimeout(() => process.exit(0), 6000);
    `
    const host = `
      const { spawn } = require("node:child_process");
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" });
      child.on("exit", () => console.log("descendant-reaped"));
      setInterval(() => {}, 1000);
    `
    let directChild
    let output = ""
    try {
      await assert.rejects(
        runContractHost(process.execPath, ["-e", host], {
          label: "descendant-pipes",
          timeoutMs: 1500,
          killGraceMs: 500,
          closeGraceMs: 500,
          spawnChild: (...args) => {
            directChild = spawn(...args)
            directChild.stdout.on("data", (chunk) => (output += chunk))
            return directChild
          },
        }),
        (error) => {
          assert.match(error.message, /timed out: descendant-pipes/)
          assert.match(error.message, /descendant-ready:\d+/)
          assert.match(error.message, /descendant-reaped/)
          assert.doesNotMatch(error.message, /stdio did not close/)
          return true
        },
      )
      const pid = Number(output.match(/descendant-ready:(\d+)/)[1])
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
      assert.throws(() => process.kill(directChild.pid, 0), { code: "ESRCH" })
    } finally {
      // Bound cleanup even if an assertion detects a broken implementation.
      try {
        directChild?.kill("SIGKILL")
      } catch {}
      const pid = Number(output.match(/descendant-ready:(\d+)/)?.[1])
      if (pid) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
    }
  },
)

test("host spawn errors are returned after close, not silently skipped", async () => {
  const child = fakeChild()
  child.kill = () => true
  const error = new Error("spawn ENOENT")
  const outcome = runContractHost("missing", [], { label: "missing", spawnChild: () => child })
  const rejected = assert.rejects(outcome, (actual) => actual === error)
  child.emit("error", error)
  child.emit("close", -2)
  await rejected
})
