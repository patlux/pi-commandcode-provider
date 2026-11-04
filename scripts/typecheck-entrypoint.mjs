#!/usr/bin/env node
/** Check the entrypoint against an installed Pi host, without installing private peers. */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function installedHostEntry(hostDir) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(hostDir, "package.json"), "utf8"))
    if (
      manifest?.name !== "@earendil-works/pi-coding-agent" ||
      typeof manifest.types !== "string" ||
      !manifest.types.endsWith(".d.ts")
    )
      throw new Error("Expected an installed Pi package with a declaration entrypoint")
    return resolve(hostDir, manifest.types)
  } catch (error) {
    throw new Error(`Cannot read installed Pi declarations: ${error.message}`)
  }
}

export function entrypointProgram(hostDir, root = repoRoot) {
  const configPath = resolve(root, "tsconfig.entrypoint.json")
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) return { diagnostics: [config.error] }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  if (parsed.errors.length) return { diagnostics: parsed.errors }

  // A path is required when Pi is installed globally (as in CI). Otherwise use
  // locally resolvable optional peers. Never substitute ambient host stubs.
  const hostEntry = hostDir
    ? installedHostEntry(hostDir)
    : ts.resolveModuleName(
        "@earendil-works/pi-coding-agent",
        resolve(root, "index.ts"),
        parsed.options,
        ts.sys,
      ).resolvedModule?.resolvedFileName
  if (!hostEntry || !ts.sys.fileExists(hostEntry)) {
    throw new Error(
      "Pi declarations not found. Pass its installed package directory: npm run typecheck:entrypoint -- /path/to/@earendil-works/pi-coding-agent",
    )
  }
  const resolveAi = (specifier) => {
    const entry = ts.resolveModuleName(specifier, hostEntry, parsed.options, ts.sys).resolvedModule
      ?.resolvedFileName
    if (!entry || !/\.d\.[cm]?ts$/.test(entry)) {
      throw new Error(`Installed Pi does not expose declarations for ${specifier}`)
    }
    return entry
  }
  const options = {
    ...parsed.options,
    paths: {
      "@earendil-works/pi-coding-agent": [hostEntry],
      "@earendil-works/pi-ai": [resolveAi("@earendil-works/pi-ai")],
      "@earendil-works/pi-ai/compat": [resolveAi("@earendil-works/pi-ai/compat")],
    },
  }
  const program = ts.createProgram(parsed.fileNames, options)
  return { program, diagnostics: ts.getPreEmitDiagnostics(program) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3)
      throw new Error("Expected at most one installed Pi package directory")
    const { diagnostics } = entrypointProgram(process.argv[2])
    if (diagnostics.length) {
      console.error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCanonicalFileName: (path) => path,
          getCurrentDirectory: () => repoRoot,
          getNewLine: () => "\n",
        }),
      )
      process.exitCode = 1
    } else {
      console.log("[typecheck:entrypoint] PASS — index.ts and host-boundary contracts")
    }
  } catch (error) {
    console.error(`[typecheck:entrypoint] FAIL — ${error.message}`)
    process.exitCode = 1
  }
}
