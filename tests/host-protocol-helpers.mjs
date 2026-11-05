import assert from "node:assert/strict"
import { spawn } from "node:child_process"

// These catalog models must retain reasoning and image input. The generated
// preflight extension checks the actual checkout (or installed tarball) before
// registering tools. Responses depends on discovery's supported_endpoints;
// Claude depends on apiForModelId's Anthropic routing rule.
export const CONTRACT_MODELS = [
  { id: "deepseek/deepseek-v4.1-flash", wire: "chat/completions", api: "openai-completions" },
  { id: "meta/muse-spark-1.3", wire: "responses", api: "openai-responses" },
  { id: "claude-sonnet-4-6", wire: "messages", api: "anthropic-messages" },
]

// Distinct, valid 1x1 red/blue PNGs let each result's payload be checked.
export const CONTRACT_IMAGES = {
  A: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  B: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
}
const imageUrl = (data) => `data:image/png;base64,${data}`

/** Instructions must occupy a system slot, not merely occur in user history. */
export function assertSystemInstructions(body, wire) {
  const isSystem = (message) => ["system", "developer"].includes(message.role)
  const instructions =
    wire === "messages"
      ? body.system
      : wire === "responses"
        ? [body.instructions, ...(body.input ?? []).filter(isSystem).map((item) => item.content)]
        : body.messages.filter(isSystem).map((message) => message.content)
  assert.match(
    JSON.stringify(instructions) ?? "",
    /contract-system-sentinel/,
    `${wire}: system instructions must reach a system/instructions field`,
  )
}

/** Inspect typed image result parts, never the tool-call arguments or prompt. */
export function assertToolImages(body, wire) {
  if (wire === "chat/completions") {
    // Completions encodes tool images in a subsequent user message, not in the
    // tool message itself. Both payloads must survive in actual image parts.
    const images = body.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "image_url")
    assert.deepEqual(
      images.map((part) => part.image_url?.url).sort(),
      Object.values(CONTRACT_IMAGES).map(imageUrl).sort(),
      "Both Completions tool images must reach the follow-up as image_url parts",
    )
    return
  }
  assert.ok(["responses", "messages"].includes(wire), `Unknown contract wire: ${wire}`)
  const results =
    wire === "responses"
      ? body.input.filter((item) => item.type === "function_call_output")
      : body.messages
          .flatMap((message) => message.content ?? [])
          .filter((part) => part.type === "tool_result")
  assert.equal(results.length, 2, "Two image-bearing tool results are required")
  for (const [label, data] of Object.entries(CONTRACT_IMAGES)) {
    const contentOf = (result) => (wire === "responses" ? result.output : result.content)
    const result = results.find((item) =>
      contentOf(item)?.some?.((part) => part.text === `contract-result-${label}`),
    )
    assert.ok(result, `Missing typed tool result ${label}`)
    const content = contentOf(result)
    const images = content.filter((part) =>
      wire === "responses" ? part.type === "input_image" : part.type === "image",
    )
    assert.equal(images.length, 1, `Tool result ${label} must contain exactly one image`)
    if (wire === "responses") {
      assert.equal(images[0].image_url, imageUrl(data), `Wrong Responses image for ${label}`)
    } else {
      assert.deepEqual(
        images[0].source,
        { type: "base64", media_type: "image/png", data },
        `Wrong Anthropic image for ${label}`,
      )
    }
  }
}

/** Wait for close normally; bound stuck stdio after killing a timed-out host. */
export function runContractHost(
  binary,
  args,
  {
    cwd,
    env,
    label,
    timeoutMs = 45_000,
    killGraceMs = 1_000,
    closeGraceMs = 1_000,
    spawnChild = spawn,
  },
) {
  return new Promise((resolveRun, reject) => {
    // On POSIX, give the host its own process group so inherited-pipe descendants
    // receive the timeout signals too, even after the direct host has exited.
    // Windows has no negative-PID group signalling: only its direct child is killed.
    const grouped = process.platform !== "win32"
    const child = spawnChild(binary, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: grouped,
    })
    let stdout = "",
      stderr = "",
      timedOut = false,
      settled = false,
      killSent = false,
      spawnError,
      signalError,
      killTimer,
      closeTimer
    const signal = (name) => {
      if (name === "SIGKILL") {
        if (killSent) return
        killSent = true
      }
      try {
        if (grouped && child.pid) process.kill(-child.pid, name)
        else child.kill(name)
      } catch (error) {
        if (error.code !== "ESRCH") signalError = error
      }
    }
    const finish = (code, incomplete = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(closeTimer)
      if (incomplete) {
        // Escaped descendants may still hold pipe write ends. Close our read ends
        // so a missing close event cannot keep this test runner alive indefinitely.
        child.stdout.destroy()
        child.stderr.destroy()
        // If the OS denied termination, report failure without retaining the
        // process handle as an event-loop ref. This is not a successful cleanup.
        child.unref?.()
      }
      if (spawnError) reject(spawnError)
      else if (timedOut)
        reject(
          new Error(
            `Contract host timed out: ${label}\n${stdout}\n${stderr}` +
              (incomplete
                ? "\nstdio did not close after SIGKILL; read pipes destroyed; process cleanup unconfirmed"
                : "") +
              (signalError ? `\nsignal error: ${signalError.message}` : ""),
          ),
        )
      else resolveRun({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTimer = setTimeout(() => {
        closeTimer = setTimeout(() => finish(null, true), closeGraceMs)
        signal("SIGKILL")
      }, killGraceMs)
      signal("SIGTERM")
    }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      spawnError = error
    })
    child.on("close", (code) => {
      if (settled) return
      // A prompt close must not cancel escalation for remaining group members.
      if (timedOut) signal("SIGKILL")
      finish(code)
    })
  })
}
