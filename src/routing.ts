import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
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
  if (!("version" in value) || value.version !== 1 || !("models" in value)) {
    throw new Error("Unsupported routing configuration version")
  }
  const models = value.models
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    throw new Error("Routing models must be an object")
  }
  const entries = Object.entries(models)
  if (entries.some(([id, choice]) => !id.trim() || !isEndpointChoice(choice))) {
    throw new Error("Routing choices must be auto, responses, or chat-completions")
  }
  return Object.fromEntries(
    entries.filter((entry): entry is [string, EndpointChoice] => isEndpointChoice(entry[1])),
  )
}

export async function loadEndpointOverrides(path: string): Promise<EndpointOverrides> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    return parseEndpointOverrides(value)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {}
    // Do not echo file contents, JSON parse excerpts, paths, or arbitrary values.
    throw new Error(
      "Could not read Command Code routing configuration; check its version and model choices",
    )
  }
}

export function resolveEndpoint(
  model: CommandCodeModel,
  overrides: EndpointOverrides,
): CommandCodeApi {
  const choice = overrides[model.id] ?? "auto"
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

/** The routing file is separate from the generated model cache and package contents. */
export async function saveEndpointChoice(
  path: string,
  modelId: string,
  choice: EndpointChoice,
): Promise<EndpointOverrides> {
  const overrides = { ...(await loadEndpointOverrides(path)) }
  if (choice === "auto") delete overrides[modelId]
  else
    Object.defineProperty(overrides, modelId, {
      value: choice,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, models: overrides }, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  return overrides
}
