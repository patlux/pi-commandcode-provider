import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import {
  COMMAND_CODE_CLI_VERSION,
  MODEL_EFFORTS,
  MODEL_INPUT_MODALITIES,
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_REASONING,
} from "../../src/commandcode-catalog.ts"

const execFileAsync = promisify(execFile)
const MODELS_REFERENCE_PATH = "dist/bundled/command-code-knowledge/reference/models.md"
const CLI_BUNDLE_PATH = "dist/cli.mjs"
const TEXT_ONLY_MARKER = ',__name(isKnownTextOnlyModel,"isKnownTextOnlyModel")'
const VALID_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"])

function quoteWindowsArgument(argument: string): string {
  if (argument.length === 0) return '""'
  if (!/[\s"]/.test(argument)) return argument
  return `"${argument.replaceAll('"', '\\"')}"`
}

/**
 * Run npm on Windows and POSIX. npm is a `.cmd` shim on Windows, which
 * execFile cannot spawn directly, so route it through the shell there with
 * shell-safe quoting.
 */
function execNpmFileAsync(
  args: readonly string[],
  options: { cwd: string; encoding: "utf-8"; maxBuffer?: number },
): Promise<{ stdout: string }> {
  if (process.platform !== "win32") return execFileAsync("npm", args, options)
  const command = ["npm", ...args.map(quoteWindowsArgument)].join(" ")
  return execFileAsync(command, { ...options, shell: true })
}
const CATALOG_SOURCE_PATH = new URL("../../src/commandcode-catalog.ts", import.meta.url)
const README_PATH = new URL("../../README.md", import.meta.url)
const OVERRIDES_SOURCE_PATH = new URL("../../src/commandcode-catalog-overrides.ts", import.meta.url)

export interface CommandCodeModelMetadata {
  imageModelIds: readonly string[]
  reasoningModelIds: readonly string[]
  reasoningEfforts: Readonly<Record<string, readonly string[]>>
  maxOutputTokens: Readonly<Record<string, number>>
}

export interface ModelMetadataDiff {
  versionChanged: boolean
  addedImageModelIds: readonly string[]
  removedImageModelIds: readonly string[]
  addedReasoningModelIds: readonly string[]
  removedReasoningModelIds: readonly string[]
  addedEffortModelIds: readonly string[]
  removedEffortModelIds: readonly string[]
  changedEffortModelIds: readonly string[]
  addedMaxOutputModelIds: readonly string[]
  removedMaxOutputModelIds: readonly string[]
  changedMaxOutputModelIds: readonly string[]
}

interface PackedPackage {
  filename: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right))
}

function parsePackedPackage(value: unknown): PackedPackage {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new Error("Expected npm pack to return one package")
  }

  const filename = value[0].filename
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("Expected npm pack to return a tarball filename")
  }

  return { filename }
}

export function parsePackageVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(value)) {
    throw new Error("Expected npm view to return one semantic version")
  }
  return value
}

export function parseModelsReference(markdown: string): {
  modelIds: readonly string[]
  reasoningEfforts: Readonly<Record<string, readonly string[]>>
} {
  const modelIds = new Set<string>()
  const reasoningEfforts: Record<string, readonly string[]> = {}

  for (const line of markdown.split("\n")) {
    const match = /^\| `([^`]+)` \| [^|]* \| [^|]* \| ([^|]*) \|/.exec(line)
    if (!match) continue

    const modelId = match[1]
    const effortsColumn = match[2]?.trim()
    if (!modelId || !effortsColumn) throw new Error(`Could not parse model row: ${line}`)
    if (modelIds.has(modelId)) throw new Error(`Duplicate model id in reference: ${modelId}`)
    modelIds.add(modelId)

    if (effortsColumn === "—") continue

    const efforts = effortsColumn.split(",").map((effort) => effort.trim())
    if (efforts.length === 0 || efforts.some((effort) => !VALID_EFFORTS.has(effort))) {
      throw new Error(`Unexpected reasoning efforts for ${modelId}: ${effortsColumn}`)
    }
    reasoningEfforts[modelId] = efforts
  }

  if (modelIds.size === 0) throw new Error("No model rows found in Command Code reference")

  return {
    modelIds: sorted(modelIds),
    reasoningEfforts: Object.fromEntries(
      Object.entries(reasoningEfforts).sort(([left], [right]) => left.localeCompare(right)),
    ),
  }
}

export function parseKnownTextOnlyModelIds(bundle: string): readonly string[] {
  const markerIndex = bundle.indexOf(TEXT_ONLY_MARKER)
  if (markerIndex < 0) {
    throw new Error("Could not find Command Code's isKnownTextOnlyModel catalog")
  }

  const setStart = bundle.lastIndexOf("new Set([", markerIndex)
  if (setStart < 0) throw new Error("Could not find the text-only model set")

  const arrayStart = setStart + "new Set(".length
  const arrayEnd = markerIndex - 1
  const literal = bundle.slice(arrayStart, arrayEnd)
  const parsed: unknown = JSON.parse(literal)
  if (!isStringArray(parsed)) throw new Error("Expected the text-only model catalog to be strings")

  return sorted(new Set(parsed))
}

function modelObject(bundle: string, modelId: string): string {
  const start = bundle.indexOf(`{id:${JSON.stringify(modelId)},inputModalities:`)
  if (start < 0) throw new Error(`Could not find model metadata for ${modelId}`)

  let depth = 0
  let quote = ""
  let escaped = false
  for (let index = start; index < bundle.length; index += 1) {
    const character = bundle[index] ?? ""
    if (quote) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === quote) quote = ""
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (character === "{") depth += 1
    else if (character === "}" && --depth === 0) return bundle.slice(start, index + 1)
  }

  throw new Error(`Unterminated model metadata for ${modelId}`)
}

export function parseBundleModelCapabilities(
  bundle: string,
  modelIds: readonly string[],
): {
  reasoningModelIds: readonly string[]
  maxOutputTokens: Readonly<Record<string, number>>
} {
  const reasoningModelIds: string[] = []
  const maxOutputTokens: Record<string, number> = {}

  for (const modelId of modelIds) {
    const entry = modelObject(bundle, modelId)
    if (entry.includes("reasoning:!0") || entry.includes("reasoningEfforts:[")) {
      reasoningModelIds.push(modelId)
    }
    const maxOutput = /maxOutputTokens:([^,}]+)/.exec(entry)?.[1]
    if (maxOutput) {
      const value = Number(maxOutput)
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Unexpected max output tokens for ${modelId}: ${maxOutput}`)
      }
      maxOutputTokens[modelId] = value
    }
  }

  return {
    reasoningModelIds: sorted(reasoningModelIds),
    maxOutputTokens: Object.fromEntries(
      Object.entries(maxOutputTokens).sort(([left], [right]) => left.localeCompare(right)),
    ),
  }
}

export function commandCodeModelMetadataFromContents(
  modelsReference: string,
  cliBundle: string,
): CommandCodeModelMetadata {
  const reference = parseModelsReference(modelsReference)
  const textOnlyModelIds = new Set(parseKnownTextOnlyModelIds(cliBundle))
  const capabilities = parseBundleModelCapabilities(cliBundle, reference.modelIds)

  return {
    imageModelIds: reference.modelIds.filter((modelId) => !textOnlyModelIds.has(modelId)),
    reasoningModelIds: capabilities.reasoningModelIds,
    reasoningEfforts: reference.reasoningEfforts,
    maxOutputTokens: capabilities.maxOutputTokens,
  }
}

export function currentModelMetadata(): CommandCodeModelMetadata {
  return {
    imageModelIds: sorted(Object.keys(MODEL_INPUT_MODALITIES)),
    reasoningModelIds: sorted(Object.keys(MODEL_REASONING)),
    reasoningEfforts: Object.fromEntries(
      Object.entries(MODEL_EFFORTS)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([modelId, efforts]) => [modelId, [...efforts]]),
    ),
    maxOutputTokens: Object.fromEntries(
      Object.entries(MODEL_MAX_OUTPUT_TOKENS).sort(([left], [right]) => left.localeCompare(right)),
    ),
  }
}

export function diffModelMetadata(
  current: CommandCodeModelMetadata,
  upstream: CommandCodeModelMetadata,
  currentVersion = COMMAND_CODE_CLI_VERSION,
  upstreamVersion = COMMAND_CODE_CLI_VERSION,
): ModelMetadataDiff {
  const currentImages = new Set(current.imageModelIds)
  const upstreamImages = new Set(upstream.imageModelIds)
  const currentReasoning = new Set(current.reasoningModelIds)
  const upstreamReasoning = new Set(upstream.reasoningModelIds)
  const currentEffortIds = Object.keys(current.reasoningEfforts)
  const upstreamEffortIds = Object.keys(upstream.reasoningEfforts)
  const currentEffortSet = new Set(currentEffortIds)
  const upstreamEffortSet = new Set(upstreamEffortIds)
  const currentMaxOutputIds = Object.keys(current.maxOutputTokens)
  const upstreamMaxOutputIds = Object.keys(upstream.maxOutputTokens)
  const currentMaxOutputSet = new Set(currentMaxOutputIds)
  const upstreamMaxOutputSet = new Set(upstreamMaxOutputIds)

  return {
    versionChanged: currentVersion !== upstreamVersion,
    addedImageModelIds: sorted(
      upstream.imageModelIds.filter((modelId) => !currentImages.has(modelId)),
    ),
    removedImageModelIds: sorted(
      current.imageModelIds.filter((modelId) => !upstreamImages.has(modelId)),
    ),
    addedReasoningModelIds: sorted(
      upstream.reasoningModelIds.filter((modelId) => !currentReasoning.has(modelId)),
    ),
    removedReasoningModelIds: sorted(
      current.reasoningModelIds.filter((modelId) => !upstreamReasoning.has(modelId)),
    ),
    addedEffortModelIds: sorted(
      upstreamEffortIds.filter((modelId) => !currentEffortSet.has(modelId)),
    ),
    removedEffortModelIds: sorted(
      currentEffortIds.filter((modelId) => !upstreamEffortSet.has(modelId)),
    ),
    changedEffortModelIds: sorted(
      upstreamEffortIds.filter(
        (modelId) =>
          currentEffortSet.has(modelId) &&
          JSON.stringify(current.reasoningEfforts[modelId]) !==
            JSON.stringify(upstream.reasoningEfforts[modelId]),
      ),
    ),
    addedMaxOutputModelIds: sorted(
      upstreamMaxOutputIds.filter((modelId) => !currentMaxOutputSet.has(modelId)),
    ),
    removedMaxOutputModelIds: sorted(
      currentMaxOutputIds.filter((modelId) => !upstreamMaxOutputSet.has(modelId)),
    ),
    changedMaxOutputModelIds: sorted(
      upstreamMaxOutputIds.filter(
        (modelId) =>
          currentMaxOutputSet.has(modelId) &&
          current.maxOutputTokens[modelId] !== upstream.maxOutputTokens[modelId],
      ),
    ),
  }
}

export function hasModelMetadataDiff(diff: ModelMetadataDiff): boolean {
  return (
    diff.versionChanged ||
    Object.entries(diff).some(([key, modelIds]) => key !== "versionChanged" && modelIds.length > 0)
  )
}

function formatList(modelIds: readonly string[]): string {
  return modelIds.length > 0 ? modelIds.map((modelId) => `\`${modelId}\``).join(", ") : "None"
}

function formatReasoningChanges(
  modelIds: readonly string[],
  current: CommandCodeModelMetadata,
  upstream: CommandCodeModelMetadata,
): string {
  if (modelIds.length === 0) return "None"
  return modelIds
    .map(
      (modelId) =>
        `\`${modelId}\`: \`${(current.reasoningEfforts[modelId] ?? []).join(", ")}\` → \`${(
          upstream.reasoningEfforts[modelId] ?? []
        ).join(", ")}\``,
    )
    .join("<br>")
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

function recordEntries(
  values: Readonly<Record<string, readonly string[]>>,
): readonly [string, readonly string[]][] {
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
}

export function renderCommandCodeCatalog(
  packageVersion: string,
  metadata: CommandCodeModelMetadata,
): string {
  const imageEntries = sorted(metadata.imageModelIds)
    .map((modelId) => `  ${quoted(modelId)}: ["text", "image"],`)
    .join("\n")
  const reasoningEntries = sorted(metadata.reasoningModelIds)
    .map((modelId) => `  ${quoted(modelId)}: true,`)
    .join("\n")
  const effortEntries = recordEntries(metadata.reasoningEfforts)
    .map(
      ([modelId, efforts]) =>
        `  ${quoted(modelId)}: [${efforts.map((effort) => quoted(effort)).join(", ")}],`,
    )
    .join("\n")
  const maxOutputEntries = Object.entries(metadata.maxOutputTokens)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([modelId, value]) =>
        `  ${quoted(modelId)}: ${value.toLocaleString("en-US").replaceAll(",", "_")},`,
    )
    .join("\n")

  return `export const COMMAND_CODE_CLI_VERSION = ${quoted(packageVersion)}\n\nexport type CommandCodeInputType = "text" | "image"\nexport type CommandCodeReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"\n\n/**\n * Generated from command-code@${packageVersion} by \`npm run sync:commandcode-catalog\`.\n * Do not edit manually.\n */\nexport const MODEL_INPUT_MODALITIES: Readonly<Record<string, readonly CommandCodeInputType[]>> = {\n${imageEntries}\n}\n\nexport const MODEL_REASONING: Readonly<Record<string, true>> = {\n${reasoningEntries}\n}\n\nexport const MODEL_EFFORTS: Readonly<Record<string, readonly CommandCodeReasoningEffort[]>> = {\n${effortEntries}\n}\n\nexport const MODEL_MAX_OUTPUT_TOKENS: Readonly<Record<string, number>> = {\n${maxOutputEntries}\n}\n`
}

function updateDocumentedCatalogVersion(
  contents: string,
  packageVersion: string,
  context: string,
): string {
  const pattern = /command-code@\d+\.\d+\.\d+(?:[-+][^`\s,]+)?/
  if (!pattern.test(contents)) throw new Error(`Could not find the ${context} catalog version`)
  return contents.replace(pattern, `command-code@${packageVersion}`)
}

const EFFORT_OVERRIDE_ENTRY = /^\s*"((?:[^"\\]|\\.)+)":\s*\[/

/**
 * Drop manual effort overrides that upstream now publishes itself.
 *
 * `tests/test-models.ts` fails while an override duplicates upstream efforts, so
 * leaving the removal to a human kept the scheduled workflow red and blocked its
 * own pull request. The overrides file is hand-formatted, so this rewrites entries
 * and leaves comments, ordering, and still-needed entries untouched.
 */
export function pruneObsoleteEffortOverrides(
  contents: string,
  upstreamEffortModelIds: readonly string[],
): { contents: string; removedModelIds: readonly string[] } {
  const upstreamModelIds = new Set(upstreamEffortModelIds)
  const removedModelIds: string[] = []
  const keptLines: string[] = []
  const lines = contents.split("\n")

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const match = EFFORT_OVERRIDE_ENTRY.exec(line)
    const modelId = match?.[1]

    if (match === null || modelId === undefined || !upstreamModelIds.has(modelId)) {
      keptLines.push(line)
      continue
    }

    removedModelIds.push(modelId)

    // Prettier wraps an entry whose id is too long to fit the print width, so the
    // effort array continues on the following lines. Consume them up to the closing
    // bracket, otherwise they are left behind as invalid syntax.
    if (line.includes("]")) continue
    for (index += 1; index < lines.length; index += 1) {
      if ((lines[index] ?? "").includes("]")) break
    }
  }

  if (removedModelIds.length === 0) return { contents, removedModelIds }

  const kept = keptLines.join("\n")
  const hasRemainingEntries = keptLines.some((line) => EFFORT_OVERRIDE_ENTRY.test(line))
  return {
    contents: hasRemainingEntries ? kept : collapseEmptyOverrideMap(kept),
    removedModelIds: sorted(removedModelIds),
  }
}

/** Render an override map without entries as `= {}` so the file stays formatted. */
function collapseEmptyOverrideMap(contents: string): string {
  const openIndex = contents.indexOf("= {")
  const closeIndex = contents.lastIndexOf("}")
  if (openIndex < 0 || closeIndex < openIndex) return contents

  // Keep the trailing newline exactly once; leaving the removed block's blank
  // lines behind would fail `npm run format:check` in the sync workflow.
  const trailing = contents.slice(closeIndex + 1).replace(/^\n+/, "")
  return `${contents.slice(0, openIndex)}= {}\n${trailing}`
}

export function updateReadmeCatalogVersion(readme: string, packageVersion: string): string {
  return updateDocumentedCatalogVersion(readme, packageVersion, "README")
}

async function writeSynchronizedCatalog(
  packageVersion: string,
  metadata: CommandCodeModelMetadata,
): Promise<readonly string[]> {
  const readme = await readFile(README_PATH, "utf-8")
  await Promise.all([
    writeFile(CATALOG_SOURCE_PATH, renderCommandCodeCatalog(packageVersion, metadata), "utf-8"),
    writeFile(README_PATH, updateReadmeCatalogVersion(readme, packageVersion), "utf-8"),
  ])

  const overrides = await readFile(OVERRIDES_SOURCE_PATH, "utf-8")
  const pruned = pruneObsoleteEffortOverrides(overrides, Object.keys(metadata.reasoningEfforts))
  if (pruned.removedModelIds.length > 0) {
    await writeFile(OVERRIDES_SOURCE_PATH, pruned.contents, "utf-8")
  }
  return pruned.removedModelIds
}

function metadataReport(
  packageVersion: string,
  current: CommandCodeModelMetadata,
  upstream: CommandCodeModelMetadata,
  diff: ModelMetadataDiff,
): string {
  const status = hasModelMetadataDiff(diff) ? "❌ Drift detected" : "✅ Metadata is current"
  return [
    "## Command Code static model metadata",
    "",
    `**${status}**`,
    "",
    `- Repository snapshot: \`command-code@${COMMAND_CODE_CLI_VERSION}\``,
    `- Inspected package: \`command-code@${packageVersion}\``,
    `- Image-capable models: ${current.imageModelIds.length} repository / ${upstream.imageModelIds.length} upstream`,
    `- Reasoning models: ${current.reasoningModelIds.length} repository / ${upstream.reasoningModelIds.length} upstream`,
    `- Models with selectable efforts: ${Object.keys(current.reasoningEfforts).length} repository / ${Object.keys(upstream.reasoningEfforts).length} upstream`,
    `- Model-specific output limits: ${Object.keys(current.maxOutputTokens).length} repository / ${Object.keys(upstream.maxOutputTokens).length} upstream`,
    "",
    "| Change | Models |",
    "| --- | --- |",
    `| CLI version | ${diff.versionChanged ? `\`${COMMAND_CODE_CLI_VERSION}\` → \`${packageVersion}\`` : "Current"} |`,
    `| New image support | ${formatList(diff.addedImageModelIds)} |`,
    `| Removed image support | ${formatList(diff.removedImageModelIds)} |`,
    `| New reasoning models | ${formatList(diff.addedReasoningModelIds)} |`,
    `| Removed reasoning models | ${formatList(diff.removedReasoningModelIds)} |`,
    `| New effort metadata | ${formatList(diff.addedEffortModelIds)} |`,
    `| Removed effort metadata | ${formatList(diff.removedEffortModelIds)} |`,
    `| Changed reasoning efforts | ${formatReasoningChanges(diff.changedEffortModelIds, current, upstream)} |`,
    `| New output limits | ${formatList(diff.addedMaxOutputModelIds)} |`,
    `| Removed output limits | ${formatList(diff.removedMaxOutputModelIds)} |`,
    `| Changed output limits | ${formatList(diff.changedMaxOutputModelIds)} |`,
    "",
  ].join("\n")
}

async function resolvePackageSpec(
  packageSpec: string,
  directory: string,
  npmCacheDirectory: string,
): Promise<string> {
  if (packageSpec !== "command-code@latest") return packageSpec

  const { stdout } = await execNpmFileAsync(
    ["view", packageSpec, "version", "--json", "--prefer-online", "--cache", npmCacheDirectory],
    {
      cwd: directory,
      encoding: "utf-8",
    },
  )
  return `command-code@${parsePackageVersion(JSON.parse(stdout) as unknown)}`
}

async function inspectPackedPackage(packageSpec: string): Promise<{
  packageVersion: string
  metadata: CommandCodeModelMetadata
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-commandcode-model-check-"))
  const npmCacheDirectory = join(directory, "npm-cache")

  try {
    const resolvedPackageSpec = await resolvePackageSpec(packageSpec, directory, npmCacheDirectory)
    const { stdout } = await execNpmFileAsync(
      ["pack", resolvedPackageSpec, "--json", "--prefer-online", "--cache", npmCacheDirectory],
      {
        cwd: directory,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      },
    )
    const packed = parsePackedPackage(JSON.parse(stdout) as unknown)
    await execFileAsync("tar", ["-xzf", packed.filename], { cwd: directory })

    const packageDirectory = join(directory, "package")
    const packageJsonContents = await readFile(join(packageDirectory, "package.json"), "utf-8")
    const packageJson: unknown = JSON.parse(packageJsonContents)
    if (!isRecord(packageJson) || typeof packageJson.version !== "string") {
      throw new Error("Expected command-code package.json to contain a version")
    }

    const [modelsReference, cliBundle] = await Promise.all([
      readFile(join(packageDirectory, MODELS_REFERENCE_PATH), "utf-8"),
      readFile(join(packageDirectory, CLI_BUNDLE_PATH), "utf-8"),
    ])

    return {
      packageVersion: packageJson.version,
      metadata: commandCodeModelMetadataFromContents(modelsReference, cliBundle),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write")
  const packageSpec =
    process.argv.find((argument) => argument.startsWith("command-code@")) ?? "command-code@latest"
  const current = currentModelMetadata()
  const upstreamPackage = await inspectPackedPackage(packageSpec)
  const diff = diffModelMetadata(
    current,
    upstreamPackage.metadata,
    COMMAND_CODE_CLI_VERSION,
    upstreamPackage.packageVersion,
  )
  const report = metadataReport(
    upstreamPackage.packageVersion,
    current,
    upstreamPackage.metadata,
    diff,
  )

  console.log(report)

  if (write) {
    const removedOverrides = await writeSynchronizedCatalog(
      upstreamPackage.packageVersion,
      upstreamPackage.metadata,
    )
    console.log(`Synchronized static metadata with command-code@${upstreamPackage.packageVersion}.`)
    if (removedOverrides.length > 0) {
      console.log(
        `Removed ${removedOverrides.length} manual effort override(s) now published upstream: ${removedOverrides.join(", ")}.`,
      )
    }
    return
  }

  if (hasModelMetadataDiff(diff)) {
    throw new Error(
      `Static model metadata differs from command-code@${upstreamPackage.packageVersion}. Update src/models.ts and the snapshot version.`,
    )
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1]
  return entrypoint !== undefined && pathToFileURL(resolve(entrypoint)).href === import.meta.url
}

if (isMainModule()) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
