import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

const source = readFileSync(new URL("./test-pi-local.mjs", import.meta.url), "utf8")
const helpers = source.slice(
  source.indexOf("function runPi("),
  source.indexOf("async function runRpcQuery("),
)

test("runPi timeout waits for child close and preserves the timeout result", async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let notifyKilled
  const killed = new Promise((resolve) => {
    notifyKilled = resolve
  })
  child.kill = () => notifyKilled()
  const runPi = runInNewContext(`${helpers}\nrunPi`, {
    spawn: () => child,
    PI_BIN: "mock-pi",
    PROJECT_DIR: ".",
    env: {},
    setTimeout,
    clearTimeout,
  })

  let settled = false
  const result = runPi([], 1).then((value) => {
    settled = true
    return value
  })
  try {
    await killed
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, false, "timeout must not return before the child closes")
    child.stdout.emit("data", Buffer.from("final output"))
  } finally {
    child.emit("close", 0)
  }
  const outcome = await result
  assert.equal(outcome.code, -1)
  assert.equal(outcome.stdout, "final output")
  assert.match(outcome.stderr, /TIMEOUT after 1ms/)
})
