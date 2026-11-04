/**
 * Local HTTP callback server for the Command Code browser auth flow.
 *
 * Starts a one-shot server on a CLI-compatible localhost port. The Command Code
 * Studio website POSTs the user's API key to /callback after they authenticate.
 */

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

const DEFAULT_PORT = 5959
const DEFAULT_PORT_RANGE = 10

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface AuthCallback {
  apiKey: string
  state: string
  userId: string
  userName: string
  keyName: string
}

export interface AuthServer {
  server: Server
  port: number
  waitForCallback: Promise<AuthCallback>
}

export interface AuthServerOptions {
  startPort?: number
  portRange?: number
  expectedState?: string
}

function listenOnAvailablePort(
  server: Server,
  startPort = DEFAULT_PORT,
  range = DEFAULT_PORT_RANGE,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let offset = 0

    const tryListen = () => {
      const useFallbackPort = startPort === 0 || offset >= range
      const port = useFallbackPort ? 0 : startPort + offset

      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening)
        if (err.code === "EADDRINUSE" && !useFallbackPort) {
          offset += 1
          tryListen()
          return
        }
        reject(err)
      }

      const onListening = () => {
        server.off("error", onError)
        const address = server.address() as AddressInfo
        resolve(address.port)
      }

      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(port, "127.0.0.1")
    }

    tryListen()
  })
}

function closeServer(server: Server) {
  server.close((err: NodeJS.ErrnoException | undefined) => {
    if (err && err.code !== "ERR_SERVER_NOT_RUNNING") {
      // There is nowhere useful to report this during auth cleanup.
    }
  })
}

/**
 * Start a local HTTP server that listens for the Command Code Studio
 * to POST the API key after the user authenticates in their browser.
 *
 * The server accepts exactly one valid POST to /callback and then closes.
 */
export async function startAuthServer(options: AuthServerOptions = {}): Promise<AuthServer> {
  let resolveCallback!: (value: AuthCallback) => void
  let rejectCallback!: (error: Error) => void

  const waitForCallback = new Promise<AuthCallback>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })

  const server = createServer((req, res) => {
    // CORS: allow requests from the Command Code Studio origins only. A local
    // development origin would let any page on that port reach the callback.
    const origin = req.headers.origin || ""
    const allowedOrigins = ["https://commandcode.ai", "https://staging.commandcode.ai"]
    // CORS response headers do not prevent cross-origin POST side effects.
    // Reject untrusted browser origins before handling the callback.
    if (origin && !allowedOrigins.includes(origin)) {
      res.writeHead(403, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ success: false, error: "Origin not allowed" }))
      return
    }

    const responseOrigin = origin || allowedOrigins[0]
    const requestedHeaders = req.headers["access-control-request-headers"]

    res.setHeader("Access-Control-Allow-Origin", responseOrigin)
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader(
      "Access-Control-Allow-Headers",
      typeof requestedHeaders === "string" && requestedHeaders.length > 0
        ? requestedHeaders
        : "Content-Type",
    )
    // Chrome's Private Network Access preflight may require this for an HTTPS
    // page posting to a localhost HTTP callback.
    res.setHeader("Access-Control-Allow-Private-Network", "true")
    res.setHeader("Content-Type", "application/json")

    // Handle CORS preflight.
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.url !== "/callback") {
      res.writeHead(404)
      res.end(JSON.stringify({ success: false, error: "Not found" }))
      return
    }

    if (req.method !== "POST") {
      res.writeHead(405)
      res.end(
        JSON.stringify({
          success: false,
          error: "Method not allowed. Use POST.",
        }),
      )
      return
    }

    let body = ""
    req.on("data", (chunk) => {
      body += chunk.toString()
      if (body.length > 10_000) req.destroy()
    })

    req.on("end", () => {
      try {
        const payload: unknown = JSON.parse(body)
        if (!isRecord(payload)) {
          res.writeHead(400)
          res.end(JSON.stringify({ success: false, error: "Invalid JSON" }))
          return
        }
        const state = typeof payload.state === "string" ? payload.state : ""

        // Only the page that received the state token may settle this login,
        // including by reporting an error. Anything else keeps the server
        // waiting for the legitimate callback.
        if (options.expectedState !== undefined && state !== options.expectedState) {
          res.writeHead(403)
          res.end(JSON.stringify({ success: false, error: "Invalid state token" }))
          return
        }

        if (payload.error) {
          res.writeHead(200)
          res.end(JSON.stringify({ success: true }))
          const description =
            typeof payload.error_description === "string"
              ? payload.error_description
              : String(payload.error)
          if (payload.error === "access_denied") {
            rejectCallback(new Error(description || "Authorization was denied by the user"))
          } else {
            rejectCallback(new Error(description || String(payload.error)))
          }
          closeServer(server)
          return
        }

        const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : ""
        const userId = typeof payload.userId === "string" ? payload.userId : ""
        const userName = typeof payload.userName === "string" ? payload.userName : ""
        const keyName = typeof payload.keyName === "string" ? payload.keyName : ""

        if (!apiKey || !state || !userId || !userName || !keyName) {
          res.writeHead(400)
          res.end(
            JSON.stringify({
              success: false,
              error: "Missing required fields",
            }),
          )
          return
        }

        res.writeHead(200)
        res.end(JSON.stringify({ success: true }))

        resolveCallback({ apiKey, state, userId, userName, keyName })
        closeServer(server)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ success: false, error: "Invalid JSON" }))
      }
    })

    req.on("error", () => {
      res.writeHead(500)
      res.end(JSON.stringify({ success: false, error: "Request error" }))
    })
  })

  try {
    const port = await listenOnAvailablePort(
      server,
      options.startPort ?? DEFAULT_PORT,
      options.portRange ?? DEFAULT_PORT_RANGE,
    )
    return { server, port, waitForCallback }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const error = new Error(`Failed to start auth server: ${message}`)
    rejectCallback(error)
    throw error
  }
}
