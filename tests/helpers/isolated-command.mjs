import { spawn, spawnSync } from "node:child_process"

/** Bounded, owned single-process command. Only synthetic tests may echo output. */
export async function isolatedCommand(
  command,
  args,
  { cwd, env, input = "", timeoutMs = 120_000 },
) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = "",
    stderr = "",
    timer,
    timedOut = false,
    started = ""
  const identity = () => {
    const result = spawnSync("ps", ["-p", String(child.pid), "-o", "pid=,lstart=,command="], {
      encoding: "utf8",
    })
    return result.status === 0 ? result.stdout.trim() : ""
  }
  // Subscribe before inspecting: package validation can exit faster than ps.
  const outcome = new Promise((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
    child.on("spawn", () => {
      started = identity()
      timer = setTimeout(() => {
        timedOut = true
        const current = identity()
        if (child.exitCode !== null || child.signalCode !== null || !current) return
        if (!started || current !== started || !current.includes(command)) {
          reject(new Error("Refusing to stop a changed or unverified isolated command"))
          return
        }
        child.kill("SIGTERM")
      }, timeoutMs)
    })
  })
  child.stdout.on("data", (data) => {
    stdout += data
  })
  child.stderr.on("data", (data) => {
    stderr += data
  })
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") stderr += `\nstdin: ${error.message}`
  })
  child.stdin.end(input)
  return { ...(await outcome), stdout, stderr, timedOut }
}
