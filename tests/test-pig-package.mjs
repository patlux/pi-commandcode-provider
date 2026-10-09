import assert from "node:assert/strict"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:http"
import { isolatedHome } from "./helpers/pig-process.mjs"
import { isolatedCommand } from "./helpers/isolated-command.mjs"

const binary = process.env.PIG_BIN
if (!binary) throw new Error("PIG_BIN is required for packed-package verification")
const root = fileURLToPath(new URL("../", import.meta.url))
const source = join(root, "packages/pig-commandcode-provider")
const sandbox = await isolatedHome()
const artifactDir = join(sandbox.home, "artifacts")
await mkdir(artifactDir)
const server = createServer((req, res) => {
  assert.equal(req.url, "/provider/v1/models")
  res.setHeader("Content-Type", "application/json")
  res.end(
    JSON.stringify({
      object: "list",
      data: [{ id: "gpt-4.1", name: "GPT", context_length: 128000 }],
    }),
  )
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${server.address().port}/provider/v1`
const env = {
  ...sandbox.env,
  COMMANDCODE_API_BASE: base,
  COMMANDCODE_MODELS_URL: `${base}/models`,
  COMMAND_CODE_API_KEY: "synthetic-pig-key",
}

async function run(command, args, cwd = sandbox.cwd, extra = {}) {
  const outcome = await isolatedCommand(command, args, {
    cwd,
    env: { ...env, ...extra },
    timeoutMs: 180_000,
  })
  assert.equal(outcome.timedOut, false, `${command} exceeded bounded test lifetime`)
  assert.equal(
    outcome.code,
    0,
    `${command} ${args.join(" ")}\n${outcome.stdout}\n${outcome.stderr}`,
  )
  return outcome.stdout
}

try {
  const rootPacked = JSON.parse(
    await run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], root),
  )[0]
  assert.ok(
    !rootPacked.files.some(
      (file) =>
        file.path.startsWith("packages/") ||
        file.path.startsWith("patches/") ||
        /\.(go|mod|sum|patch)$/.test(file.path) ||
        /^scripts\/.*pig/.test(file.path),
    ),
    "native sources leaked into TypeScript tarball",
  )
  const packed = JSON.parse(
    await run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", artifactDir],
      source,
    ),
  )[0]
  const names = packed.files.map((file) => file.path)
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "extensions/pig-commandcode-provider/go.mod",
    "extensions/pig-commandcode-provider/go.sum",
    "extensions/pig-commandcode-provider/catalog.json",
    "extensions/pig-commandcode-provider/testdata/contracts.json",
    "third_party/pig-sdk/go.mod",
    "third_party/pig-sdk/LICENSE",
    "third_party/pig-sdk/PROVENANCE.md",
  ])
    assert.ok(names.includes(required), required)
  assert.ok(
    names.every(
      (name) =>
        name === "extensions/pig-commandcode-provider/testdata/contracts.json" ||
        /^(package\.json|README\.md|LICENSE|extensions\/pig-commandcode-provider\/[^/]+\.(go|mod|sum|json)|third_party\/pig-sdk\/(?:json\/)?[^/]+\.(go|mod)|third_party\/pig-sdk\/(LICENSE|json\/LICENSE|PROVENANCE\.md))$/.test(
          name,
        ),
    ),
    JSON.stringify(names),
  )
  assert.ok(
    !names.some((name) => /\.(ts|mjs|js)$/.test(name)),
    "native tarball contains a Node entrypoint",
  )
  await writeFile(
    join(sandbox.cwd, "package.json"),
    JSON.stringify({ name: "packed-native-test", private: true }),
  )
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--omit=peer",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    join(artifactDir, packed.filename),
  ])
  const installed = join(sandbox.cwd, "node_modules/pig-commandcode-provider")
  const extension = join(installed, "extensions/pig-commandcode-provider")
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"))
  assert.deepEqual(manifest.pi.extensions, ["./extensions/pig-commandcode-provider"])
  const module = await readFile(join(extension, "go.mod"), "utf8")
  for (const replacement of module.matchAll(/=>\s+(\S+)/g)) {
    const target = replacement[1]
    assert.ok(!isAbsolute(target) && !/^[A-Z]:/i.test(target), "absolute replacement in artifact")
    if (!target.startsWith(".")) continue
    const contained = relative(installed, resolve(extension, target))
    assert.ok(
      contained !== ".." && !contained.startsWith("../") && !isAbsolute(contained),
      "replacement escapes installed package",
    )
    await readFile(join(extension, target, "go.mod"), "utf8")
  }
  await run("go", ["test", "./..."], extension, { GOWORK: "off" })
  const validated = await run(resolve(binary), [
    "package",
    "validate",
    installed,
    "--json",
    "--no-input",
  ])
  console.log("PASS self-contained tarball and PiG package validation", validated.trim())
  await run(resolve(binary), ["install", installed])
  const settings = JSON.parse(await readFile(join(sandbox.agent, "settings.json"), "utf8"))
  assert.ok(
    settings.packages.some(
      (item) => resolve(sandbox.agent, typeof item === "string" ? item : item.source) === installed,
    ),
    JSON.stringify(settings.packages),
  )
  const cold = await run(resolve(binary), ["--list-models", "commandcode"])
  assert.ok(cold.includes("gpt-4.1"), cold)
  const warm = await run(resolve(binary), ["--list-models", "commandcode"])
  assert.ok(warm.includes("gpt-4.1"), warm)
  console.log("PASS actual pig install, discovery and cached restart")
  await run(process.execPath, [join(root, "tests/test-pig-local.mjs")], sandbox.cwd, {
    PIG_BIN: resolve(binary),
    PIG_EXTENSION: extension,
    PIG_TEST_GOCACHE: sandbox.env.GOCACHE,
  })
  await run(process.execPath, [join(root, "tests/test-pig-state.mjs")], sandbox.cwd, {
    PIG_BIN: resolve(binary),
    PIG_EXTENSION: extension,
    PIG_TEST_GOCACHE: sandbox.env.GOCACHE,
  })
  await run(process.execPath, [join(root, "tests/test-pig-login.mjs")], sandbox.cwd, {
    PIG_BIN: resolve(binary),
    PIG_PACKAGE: installed,
    PIG_TEST_GOCACHE: sandbox.env.GOCACHE,
  })
  console.log("PASS native streaming, state and actual CLI login against exact installed tarball")
  await run(resolve(binary), ["remove", installed])
  const removed = JSON.parse(await readFile(join(sandbox.agent, "settings.json"), "utf8"))
  assert.ok(
    !removed.packages?.some(
      (item) => resolve(sandbox.agent, typeof item === "string" ? item : item.source) === installed,
    ),
  )
  assert.ok(
    (await readdir(installed)).includes("package.json"),
    "local remove must not delete user-owned source",
  )
  console.log("PASS package removal leaves no registered source")
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await sandbox.remove()
}
