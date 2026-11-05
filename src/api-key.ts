import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * Credential files consulted after the environment, in precedence order (also
 * documented in README.md). pi honors `PI_CODING_AGENT_DIR` for its agent
 * directory, so a profile started with that variable must not fall back to the
 * default `~/.pi/agent/auth.json` of another profile.
 */
export function defaultAuthPaths(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const piAgentDir = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent")
  return [
    join(home, ".commandcode", "auth.json"),
    join(piAgentDir, "auth.json"),
    join(home, ".omp", "agent", "auth.json"),
  ]
}

function apiKeyFromCredential(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined

  if (stringValue(value.type) === "oauth") return stringValue(value.access)
  if (stringValue(value.type) === "api") return stringValue(value.key)
  return stringValue(value.access) ?? stringValue(value.key)
}

export interface ApiKeyLookupOptions {
  env?: NodeJS.ProcessEnv
  authPaths?: readonly string[]
  homeDir?: () => string
}

/**
 * The single credential reader shared by the Provider API path and the
 * quota/usage commands: environment first, then the auth
 * files above. Hosts resolve their own stored credentials before this runs;
 * this is the ambient fallback for keys they do not know about.
 */
export function getConfiguredApiKey(options: ApiKeyLookupOptions = {}): string | undefined {
  const env = options.env ?? process.env
  if (env.COMMAND_CODE_API_KEY) return env.COMMAND_CODE_API_KEY
  if (env.COMMANDCODE_API_KEY) return env.COMMANDCODE_API_KEY

  const home = options.homeDir?.() ?? homedir()
  const authPaths = options.authPaths ?? defaultAuthPaths(home, env)

  for (const authPath of authPaths) {
    try {
      if (!existsSync(authPath)) continue
      const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"))
      if (!isRecord(parsed)) continue

      // Legacy: direct apiKey or commandcode field.
      const apiKey = stringValue(parsed.apiKey)
      if (apiKey) return apiKey

      // pi stores OAuth credentials as {"commandcode": {"type":"oauth","access":"..."}}.
      // The official Command Code CLI stores API credentials under "command-code".
      const commandcode = stringValue(parsed.commandcode)
      if (commandcode) return commandcode

      const providerKey = apiKeyFromCredential(parsed.commandcode)
      if (providerKey) return providerKey

      const commandCode = stringValue(parsed["command-code"])
      if (commandCode) return commandCode

      const commandCodeKey = apiKeyFromCredential(parsed["command-code"])
      if (commandCodeKey) return commandCodeKey
    } catch {
      // Ignore malformed or unreadable auth files.
    }
  }

  return undefined
}

// Hosts such as OMP may pass a literal env-var name as the "resolved" registry
// key instead of the actual credential. Treat those as unresolved.
export const COMMAND_CODE_PLACEHOLDER_KEYS = new Set([
  "$COMMAND_CODE_API_KEY",
  "COMMAND_CODE_API_KEY",
  "$COMMANDCODE_API_KEY",
  "COMMANDCODE_API_KEY",
])

function usableCommandCodeApiKey(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined
  if (!trimmed) return undefined
  if (COMMAND_CODE_PLACEHOLDER_KEYS.has(trimmed)) return undefined
  return trimmed
}

/**
 * Pick the real API key from a host registry value and/or the env/auth-file
 * fallback, never returning a literal placeholder or an empty/whitespace value.
 * Pure/testable.
 */
export function pickCommandCodeApiKey(
  registryKey: string | undefined,
  hostKey: string | undefined,
): string | undefined {
  return usableCommandCodeApiKey(registryKey) ?? usableCommandCodeApiKey(hostKey)
}

/**
 * Replace a host-supplied placeholder (or missing key) with the configured
 * fallback. Used for both registerProvider and the Provider API stream path.
 */
export function withResolvedCommandCodeApiKey<T extends { apiKey?: string }>(
  options: T | undefined,
  configuredKey: string | undefined,
): T | { apiKey?: string } {
  const apiKey = pickCommandCodeApiKey(options?.apiKey, configuredKey)
  if (options && apiKey === options.apiKey) return options
  return { ...options, apiKey }
}
