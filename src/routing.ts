// Persistent endpoint choices carried forward from #158 by @patlux.
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname } from "node:path"
import type { CommandCodeApi, CommandCodeModel } from "./models.ts"

export type EndpointChoice = "auto" | "responses" | "chat-completions"
export type EndpointOverrides = Readonly<Record<string, EndpointChoice>>

export function isEndpointChoice(value: unknown): value is EndpointChoice {
  return value === "auto" || value === "responses" || value === "chat-completions"
}

export function parseEndpointOverrides(value: unknown): EndpointOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Routing configuration must be an object with version: 1 and models")
  }
  if (
    !Object.hasOwn(value, "version") ||
    !("version" in value) ||
    value.version !== 1 ||
    !Object.hasOwn(value, "models") ||
    !("models" in value)
  ) {
    throw new Error("Unsupported routing configuration version")
  }
  const models = value.models
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    throw new Error("Routing models must be an object")
  }
  const entries = Object.entries(models)
  if (entries.some(([id, choice]) => !id || id !== id.trim() || !isEndpointChoice(choice))) {
    throw new Error(
      "Routing choices must be auto, responses, or chat-completions with exact model IDs",
    )
  }
  // fromEntries defines own properties, including __proto__, without mutating the prototype.
  // Explicit auto and an absent entry must have the same status and persistence semantics.
  return Object.fromEntries(
    entries.filter(
      (entry): entry is [string, EndpointChoice] =>
        isEndpointChoice(entry[1]) && entry[1] !== "auto",
    ),
  )
}

async function readRoutingFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    // Never surface OS errors, local paths, JSON excerpts, or arbitrary file contents.
    throw new Error("Could not read commandcode-routing.json in the agent directory")
  }
}

export async function loadEndpointOverrides(path: string): Promise<EndpointOverrides> {
  const raw = await readRoutingFile(path)
  if (raw === undefined) return {}
  try {
    return parseEndpointOverrides(JSON.parse(raw.toString("utf8")))
  } catch {
    throw new Error("Invalid commandcode-routing.json in the agent directory")
  }
}

export function endpointChoiceForModel(
  modelId: string,
  overrides: EndpointOverrides,
): EndpointChoice {
  return Object.hasOwn(overrides, modelId) ? overrides[modelId] : "auto"
}

export function resolveEndpoint(
  model: CommandCodeModel,
  overrides: EndpointOverrides,
): CommandCodeApi {
  const choice = endpointChoiceForModel(model.id, overrides)
  if (choice === "auto") return model.api
  if (model.api === "anthropic-messages") {
    throw new Error("Claude models require Anthropic Messages; use auto")
  }
  if (choice === "responses" && model.api !== "openai-responses") {
    throw new Error(
      "The current catalog does not advertise Responses for this model; refresh the catalog or use auto",
    )
  }
  return choice === "responses" ? "openai-responses" : "openai-completions"
}

/** Preserve host/user compatibility only when it is tagged for the actual wire.
 * Unknown or stale wire metadata must be replaced, never merged across wires.
 */
export function compatForEndpoint<T>(
  model: CommandCodeModel | undefined,
  wire: CommandCodeApi,
  fallback: T,
  forModel: (model: CommandCodeModel) => T,
): T {
  if (!model) return fallback
  if (
    fallback !== null &&
    typeof fallback === "object" &&
    Object.hasOwn(fallback, "commandCodeWire") &&
    "commandCodeWire" in fallback &&
    fallback.commandCodeWire === wire
  )
    return fallback
  return forModel({ ...model, api: wire })
}

/** Explicit command write only. Startup reads never rewrite or back up the file.
 * A malformed file is preserved before replacement; unreadable files are not overwritten.
 * Writes within one host are serialized by the command; separate hosts are not coordinated.
 */
export async function saveEndpointChoice(
  path: string,
  modelId: string,
  choice: EndpointChoice,
): Promise<{
  overrides: EndpointOverrides
  backupFile?: string
}> {
  if (!modelId || modelId !== modelId.trim() || !isEndpointChoice(choice)) {
    throw new Error("Invalid endpoint choice or model ID")
  }
  const raw = await readRoutingFile(path)
  let overrides: Record<string, EndpointChoice> = {}
  let invalid = false
  if (raw !== undefined) {
    try {
      overrides = { ...parseEndpointOverrides(JSON.parse(raw.toString("utf8"))) }
    } catch {
      invalid = true
    }
  }
  if (choice === "auto") delete overrides[modelId]
  else
    Object.defineProperty(overrides, modelId, {
      value: choice,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  const temporary = `${path}.${randomUUID()}.tmp`
  const backup = invalid ? `${path}.invalid-${randomUUID()}.bak` : undefined
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, JSON.stringify({ version: 1, models: overrides }, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    // If the backup fails, leave the original file untouched and do not install the new one.
    if (backup && raw !== undefined) await writeFile(backup, raw, { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
    return { overrides, ...(backup ? { backupFile: basename(backup) } : {}) }
  } catch {
    throw new Error(
      "Could not save commandcode-routing.json in the agent directory; check file permissions",
    )
  } finally {
    // Cleanup must not replace the sanitized error with an OS message containing local paths.
    await rm(temporary, { force: true }).catch(() => {})
  }
}
