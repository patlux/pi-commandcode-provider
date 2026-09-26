#!/usr/bin/env node
/** Install an exact tarball outside the checkout and exercise both real hosts.
 * No live account: existing integration suites use loopback mocks and temporary homes.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const tarball = process.argv[2]
assert.ok(
  tarball?.endsWith(".tgz"),
  "Usage: node tests/test-release-package.mjs /absolute/path/package.tgz",
)
const packagePath = resolve(tarball)
const testsDir = dirname(fileURLToPath(import.meta.url))
const temp = mkdtempSync(join(tmpdir(), "cc-release-package-"))

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`)
}

try {
  const home = join(temp, "home")
  mkdirSync(home)
  const config = join(temp, "npmrc")
  writeFileSync(config, "registry=https://registry.npmjs.org/\n", { mode: 0o600 })
  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }))
  // Keep only tool-discovery/OS variables. Do not inherit npm tokens, Command Code
  // keys, Pi auth paths, NODE_OPTIONS, or a developer's extension configuration.
  const env = Object.fromEntries(
    ["PATH", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "LANG", "PI_BIN", "OMP_BIN"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  )
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    NPM_CONFIG_USERCONFIG: config,
    NPM_CONFIG_CACHE: join(temp, "npm-cache"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_LOCAL_REQUIRED: "1",
    OMP_COMPAT_REQUIRED: "1",
  })
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=peer",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      packagePath,
    ],
    { cwd: temp, env },
  )
  const installed = join(temp, "node_modules", "pi-commandcode-provider")
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"))
  assert.equal(manifest.name, "pi-commandcode-provider")
  env.COMMANDCODE_TEST_PACKAGE_DIR = installed
  console.log(
    `[release-package] Testing installed ${manifest.name}@${manifest.version} from ${packagePath}`,
  )
  for (const suite of ["test-pi-local.mjs", "test-omp-compat.mjs"]) {
    run(process.execPath, [join(testsDir, suite)], { cwd: temp, env })
  }
  console.log("[release-package] PASS: packed package loaded and exercised by Pi and OMP")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
