// Zero-data-retention opt-in, carried in settings.json for hosts where setting
// a process environment variable is inconvenient. Command Code documents the
// `x-cmd-zdr: 1` request header and the `CMD_ZDR=1` CLI environment variable.
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/** Top-level settings.json section owned by this provider. */
export const ZDR_SETTINGS_SECTION = "commandcode"
export const ZDR_SETTING_KEY = "enableZDR"

export type ZdrSource = "off" | "settings" | "env"
export type ZdrEnvVar = "CMD_ZDR" | "COMMANDCODE_ZDR"

export interface ZdrState {
  enabled: boolean
  source: ZdrSource
  /** Environment variable that enabled ZDR, when `source` is `env`. */
  envVar?: ZdrEnvVar
}

type Environment = Record<string, string | undefined>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The host's own settings parser tolerates a leading UTF-8 BOM, so both the
 * reader and the writer do too: a BOM must not silently drop a saved opt-in.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Only a literal `true` enables ZDR, so a typo cannot silently weaken privacy. */
export function readZdrSetting(settings: unknown): boolean {
  if (!isRecord(settings)) return false
  const section = settings[ZDR_SETTINGS_SECTION]
  return isRecord(section) && section[ZDR_SETTING_KEY] === true
}

/** `CMD_ZDR` is the documented name; the legacy alias stays supported. */
export function zdrEnvVar(env: Environment = process.env): ZdrEnvVar | undefined {
  if (env.CMD_ZDR === "1") return "CMD_ZDR"
  if (env.COMMANDCODE_ZDR === "1") return "COMMANDCODE_ZDR"
  return undefined
}

/** The environment wins so a shell export cannot be silently weakened by a settings file. */
export function resolveZdr(settings: unknown, env: Environment = process.env): ZdrState {
  const envVar = zdrEnvVar(env)
  if (envVar) return { enabled: true, source: "env", envVar }
  if (readZdrSetting(settings)) return { enabled: true, source: "settings" }
  return { enabled: false, source: "off" }
}

/**
 * Read the opt-in from the agent settings file itself. Startup uses this instead
 * of the host's merged global+project view: the opt-in is owned by the agent
 * file that saveZdrSetting writes, so a project settings override cannot
 * silently turn it off (or on) after a restart.
 *
 * A missing or unreadable file is "off"; a malformed file is left for the write
 * path to report rather than failing the provider load.
 */
export async function loadZdrSettings(path: string): Promise<unknown> {
  try {
    return JSON.parse(stripBom(await readFile(path, "utf8")))
  } catch {
    return undefined
  }
}

export function zdrHeaders(state: ZdrState): Record<string, string> | undefined {
  return state.enabled ? { "x-cmd-zdr": "1" } : undefined
}

export function describeZdr(state: ZdrState): string {
  if (state.source === "env") return `on (${state.envVar ?? "environment"})`
  if (state.source === "settings") return "on (settings.json commandcode.enableZDR)"
  return "off"
}

/**
 * A symlinked settings.json (e.g. a managed file) is updated through its target
 * so the link survives; a dangling link is refused rather than replaced.
 */
async function resolveSettingsTarget(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error("Could not read settings.json in the agent directory; check file permissions")
    }
  }
  const entry = await lstat(path).catch(() => undefined)
  if (entry?.isSymbolicLink()) {
    throw new Error("settings.json is a symlink to a missing file; refusing to replace the link")
  }
  return path
}

/**
 * Persist the opt-in into the agent settings file, preserving every other key.
 *
 * Returns the written settings object so the caller resolves the effective
 * state without waiting for the host to reload the file. The host re-reads the
 * file and merges only the fields it modified on each of its own saves, so this
 * key survives later host writes; writes from separate processes are not
 * coordinated. A malformed file is never overwritten, and an unreadable file is
 * reported instead of replaced.
 */
export async function saveZdrSetting(settingsPath: string, enabled: boolean): Promise<unknown> {
  const path = await resolveSettingsTarget(settingsPath)
  let raw: string | undefined
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error("Could not read settings.json in the agent directory; check file permissions")
    }
  }

  let settings: Record<string, unknown> = {}
  const text = raw === undefined ? undefined : stripBom(raw)
  if (text !== undefined && text.trim() !== "") {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(
        "Invalid settings.json in the agent directory; refusing to overwrite it. Fix the JSON or set commandcode.enableZDR by hand.",
      )
    }
    if (!isRecord(parsed)) {
      throw new Error("settings.json must contain a JSON object; refusing to overwrite it")
    }
    settings = { ...parsed }
  }
  const section = settings[ZDR_SETTINGS_SECTION]
  settings[ZDR_SETTINGS_SECTION] = {
    ...(isRecord(section) ? section : {}),
    [ZDR_SETTING_KEY]: enabled,
  }

  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    await rename(temporary, path)
  } catch {
    throw new Error("Could not save settings.json in the agent directory; check file permissions")
  } finally {
    // Cleanup must not replace the sanitized error with an OS message containing local paths.
    await rm(temporary, { force: true }).catch(() => {})
  }
  return settings
}
