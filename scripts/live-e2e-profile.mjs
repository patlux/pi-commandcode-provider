#!/usr/bin/env node

import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const liveTest = resolve(projectDir, "tests", "test-live-e2e.mjs")
const profiles = process.argv.slice(2)

if (
  profiles.length === 0 ||
  profiles.some((profile) => profile !== "go" && profile !== "goat" && profile !== "provider")
) {
  console.error("Usage: node scripts/live-e2e-profile.mjs <go|goat|provider> [go|goat|provider]")
  process.exit(2)
}

async function credentialFor(profile) {
  const prefix =
    profile === "go"
      ? "COMMANDCODE_E2E_GO"
      : profile === "goat"
        ? "COMMANDCODE_E2E_GOAT"
        : "COMMANDCODE_E2E_PROVIDER"
  const direct = process.env[`${prefix}_API_KEY`]?.trim()
  const file = process.env[`${prefix}_API_KEY_FILE`]

  if (direct && file)
    throw new Error(`${prefix}_API_KEY and ${prefix}_API_KEY_FILE are mutually exclusive`)
  if (direct) return direct
  if (file) {
    const credential = (await readFile(file, "utf-8")).trim()
    if (credential) return credential
  }

  throw new Error(`Set ${prefix}_API_KEY_FILE (recommended) or ${prefix}_API_KEY`)
}

function modelsFor(profile) {
  const modelVariable =
    profile === "go"
      ? "COMMANDCODE_E2E_GO_MODEL"
      : profile === "goat"
        ? "COMMANDCODE_E2E_GOAT_MODEL"
        : "COMMANDCODE_E2E_PROVIDER_MODEL"
  const multiple = process.env[`${modelVariable}S`]
  if (multiple && process.env[modelVariable])
    throw new Error(`${modelVariable} and ${modelVariable}S are mutually exclusive`)
  const models = multiple?.split(",").map((model) => model.trim()) ?? [
    process.env[modelVariable] ??
      (profile === "goat" ? "xai/grok-4.6" : "deepseek/deepseek-v4-flash"),
  ]
  if (models.some((model) => !model)) throw new Error(`Empty model in ${modelVariable}S`)
  return [...new Set(models)]
}

function runProfile(profile, apiKey, model) {
  const env = {
    ...process.env,
    COMMAND_CODE_API_KEY: apiKey,
    COMMANDCODE_E2E_MODEL: model,
    COMMANDCODE_E2E_PROFILE: profile,
  }
  delete env.COMMANDCODE_API_KEY
  delete env.COMMANDCODE_E2E_GO_API_KEY
  delete env.COMMANDCODE_E2E_GOAT_API_KEY
  delete env.COMMANDCODE_E2E_PROVIDER_API_KEY

  return new Promise((resolveRun, reject) => {
    console.log(`[live-e2e:${profile}] model ${model}`)
    const child = spawn(process.execPath, [liveTest], {
      cwd: projectDir,
      env,
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolveRun()
        return
      }
      reject(new Error(`[live-e2e:${profile}] failed (${signal ?? `exit ${code}`})`))
    })
  })
}

try {
  for (const profile of profiles) {
    const models = modelsFor(profile)
    const credential = await credentialFor(profile)
    for (const model of models) await runProfile(profile, credential, model)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
