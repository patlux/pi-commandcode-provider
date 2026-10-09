import { spawn, execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"

export const PIG_REVISION = "3452432f8b10edd244f7f44f73db8c97c00126cc"

export async function isolatedHome() {
  const home = await mkdtemp(join(tmpdir(), "commandcode-pig-"))
  const agent = join(home, "agent")
  const cwd = join(home, "work")
  await mkdir(agent)
  await mkdir(cwd)
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({ packages: [], installTelemetryEnabled: false }),
  )
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    PIG_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_DIR: agent,
    LANG: "en_US.UTF-8",
    GOTOOLCHAIN: "local",
    GOWORK: "off",
    // Only share public module/build caches, never the user's auth or settings.
    GOPATH: execFileSync("go", ["env", "GOPATH"], { encoding: "utf8" }).trim(),
    GOCACHE:
      process.env.PIG_TEST_GOCACHE ??
      execFileSync("go", ["env", "GOCACHE"], { encoding: "utf8" }).trim(),
  }
  return { home, agent, cwd, env, remove: () => rm(home, { recursive: true, force: true }) }
}

function identity(pid) {
  return execFileSync("ps", ["-p", String(pid), "-o", "pid=,lstart=,command="], {
    encoding: "utf8",
  }).trim()
}

export function rpcProcess(binary, args, sandbox, overrides = {}) {
  const child = spawn(binary, [...args, "--mode", "rpc", "--no-session"], {
    cwd: sandbox.cwd,
    env: { ...sandbox.env, ...overrides },
    stdio: ["pipe", "pipe", "pipe"],
  })
  // ps may race fork/exec and still report the parent's argv for the new PID.
  // Capture its stable start time now, but verify its final command only before
  // a timeout stop. A Nix/Bun/Node launcher may legitimately exec in between.
  const startedAt = execFileSync("ps", ["-p", String(child.pid), "-o", "lstart="], {
    encoding: "utf8",
  }).trim()
  const extension = args[args.indexOf("-e") + 1]
  const events = []
  const waiters = new Set()
  let buffer = ""
  let stderr = ""
  let sequence = 0
  let eofAt, exitAt
  child.stderr.on("data", (data) => {
    stderr += data
  })
  child.stdout.on("data", (data) => {
    buffer += data
    let end
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      let event
      try {
        event = JSON.parse(line)
      } catch {
        stderr += `\nNon-JSON stdout: ${line}`
        continue
      }
      events.push(event)
      for (const waiter of waiters) {
        if (waiter.predicate(event)) {
          clearTimeout(waiter.timer)
          waiters.delete(waiter)
          waiter.resolve(event)
        }
      }
    }
  })
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code, signal) => {
      exitAt = performance.now()
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`PiG exited (${code}, ${signal}): ${stderr}`))
      }
      waiters.clear()
      resolve({ code, signal })
    })
  })
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") stderr += `\nRPC stdin: ${error.message}`
  })
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const wait = (predicate, from = 0, timeoutMs = 120_000) => {
    const event = events.slice(from).find(predicate)
    if (event) return Promise.resolve(event)
    if (child.exitCode !== null || child.signalCode !== null)
      return Promise.reject(new Error(`PiG already exited: ${stderr}`))
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error(`PiG RPC timeout: ${stderr}\n${JSON.stringify(events.slice(-4))}`))
        }, timeoutMs),
      }
      waiters.add(waiter)
    })
  }
  return {
    child,
    events,
    send,
    wait,
    stderr: () => stderr,
    shutdownDurationMs: () => exitAt - eofAt,
    processTree() {
      const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
          return match
            ? {
                pid: Number(match[1]),
                parent: Number(match[2]),
                rssKiB: Number(match[3]),
                command: match[4],
              }
            : null
        })
        .filter(Boolean)
      const owned = new Set([child.pid])
      let changed = true
      while (changed) {
        changed = false
        for (const row of rows)
          if (owned.has(row.parent) && !owned.has(row.pid)) {
            owned.add(row.pid)
            changed = true
          }
      }
      return rows.filter((row) => owned.has(row.pid))
    },
    async prompt(message) {
      const from = events.length
      send({ id: `prompt-${++sequence}`, type: "prompt", message })
      await wait((event) => event.type === "agent_settled", from)
      return events.slice(from)
    },
    async command(message) {
      const id = `command-${++sequence}`
      const from = events.length
      send({ id, type: "prompt", message })
      const result = await wait((event) => event.type === "response" && event.id === id, from)
      if (!result.success) throw new Error(`Command failed: ${JSON.stringify(result)}`)
      return events.slice(from)
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return exited
      const descendants = this.processTree().filter((row) => row.pid !== child.pid)
      eofAt = performance.now()
      child.stdin.end()
      let timer
      const graceful = await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 10_000)
        }),
      ])
      clearTimeout(timer)
      if (graceful) {
        // PiG's RPC exit kills its runtime processes without joining them.
        // Allow the OS a bounded interval to reap them; none may remain when
        // cleanup completes. This interval is not host shutdown latency.
        const deadline = performance.now() + 2_000
        let survivors
        do {
          const livePids = new Set(
            execFileSync("ps", ["-axo", "pid="], { encoding: "utf8" })
              .trim()
              .split(/\s+/)
              .map(Number),
          )
          survivors = descendants.filter((row) => livePids.has(row.pid))
          if (survivors.length === 0) return graceful
          await delay(25)
        } while (performance.now() < deadline)
        if (survivors.length > 0) {
          const details = survivors.map((row) => {
            try {
              return execFileSync(
                "ps",
                ["-p", String(row.pid), "-o", "pid=,ppid=,stat=,lstart=,command="],
                { encoding: "utf8" },
              ).trim()
            } catch {
              return `PID ${row.pid} exited between process snapshots`
            }
          })
          throw new Error(
            `Host exited but an observed extension descendant survived: ${details.join("; ")}`,
          )
        }
        return graceful
      }
      // A process stop is allowed only for the exact still-owned child, including
      // its captured start time. No PID search or process-group termination.
      const currentIdentity = identity(child.pid)
      if (
        !startedAt ||
        !currentIdentity.includes(startedAt) ||
        !currentIdentity.includes("--mode rpc") ||
        !(
          currentIdentity.includes(binary) ||
          (args.includes("-e") && currentIdentity.includes(extension))
        )
      )
        throw new Error("Refusing to stop a changed or unverified test process")
      child.kill("SIGTERM")
      await exited
      throw new Error(`PiG failed graceful stdin-EOF shutdown: ${stderr}`)
    },
  }
}
