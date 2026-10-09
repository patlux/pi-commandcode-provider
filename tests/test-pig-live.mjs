import assert from "node:assert/strict"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isolatedHome, rpcProcess } from "./helpers/pig-process.mjs"

// Opt-in only. No credential-file lookup, browser login, environment inheritance,
// tools, retry loop, or unbounded model output. Never part of default test/CI.
const profile = process.argv[2]
if (!["go", "goat", "provider"].includes(profile)) throw new Error("Choose go, goat or provider")
if (process.env.COMMANDCODE_PIG_LIVE_CONFIRM !== "paid-one-request")
  throw new Error("Explicit paid-one-request opt-in is required")
if (!process.env.PIG_BIN) throw new Error("PIG_BIN is required")
const prefix = `COMMANDCODE_E2E_${profile.toUpperCase()}`
const key = process.env[`${prefix}_API_KEY`]?.trim()
const model = process.env[`${prefix}_MODEL`]?.trim()
if (!key || !model || /[\r\n\s]/.test(model))
  throw new Error(
    "Provide this profile's explicit API_KEY and MODEL through the approved credential route",
  )
const root = fileURLToPath(new URL("../", import.meta.url))
const sandbox = await isolatedHome()
let child
try {
  child = rpcProcess(
    resolve(process.env.PIG_BIN),
    [
      "--no-extensions",
      "--no-tools",
      "-e",
      resolve(root, "packages/pig-commandcode-provider/extensions/pig-commandcode-provider"),
      "-e",
      resolve(root, "tests/fixtures/pig-live-driver"),
    ],
    sandbox,
    { COMMAND_CODE_API_KEY: key },
  )
  const events = await child.command(`/test-live ${model}`)
  assert.ok(
    events.some((event) => event.message === "bounded-live-ok"),
    "bounded request did not complete",
  )
  const status = await child.command("/commandcode-status")
  const expected = profile === "go" ? "generate" : "provider"
  assert.ok(
    status.some((event) => event.message?.includes?.(`Transport: ${expected}`)),
    "account did not select expected transport",
  )
  assert.deepEqual(await child.close(), { code: 0, signal: null })
  child = null
  console.log(`PASS bounded ${profile} request (${expected}); account plan itself was not queried`)
} catch {
  // RPC diagnostics can contain server-returned account information. Suppress them.
  console.error(`FAIL bounded ${profile} request; provider output withheld`)
  process.exitCode = 1
} finally {
  try {
    if (child) await child.close()
  } catch {
    console.error("FAIL live test process cleanup; diagnostics withheld")
    process.exitCode = 1
  } finally {
    await sandbox.remove()
  }
}
