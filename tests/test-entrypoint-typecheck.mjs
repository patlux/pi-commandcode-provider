import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import ts from "typescript"
import { entrypointProgram } from "../scripts/typecheck-entrypoint.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

test("entrypoint project includes real source and compile-only boundary contracts", () => {
  const configPath = join(root, "tsconfig.entrypoint.json")
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.options.strict, true)
  assert.equal(parsed.options.noEmit, true)
  assert.ok(parsed.fileNames.includes(join(root, "index.ts")))
  assert.ok(parsed.fileNames.includes(join(root, "src/core.ts")))
  assert.ok(parsed.fileNames.includes(join(root, "tests/types/entrypoint.ts")))
  assert.equal(parsed.options.paths, undefined, "no committed host declaration stubs")
})

test("missing host declarations fail rather than silently skip", () => {
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/typecheck-entrypoint.mjs"), join(root, "missing-host")],
    { encoding: "utf8" },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Cannot read installed Pi declarations/)
  assert.doesNotMatch(result.stdout, /PASS|SKIP/)
})

test("compiler driver checks index.ts and resolves the supplied host's actual declaration files", () => {
  // Synthetic packages exercise only the driver's plumbing. The required CI
  // gate separately runs the real entrypoint against the installed Pi package.
  const dir = mkdtempSync(join(tmpdir(), "commandcode-typecheck-"))
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  try {
    write(join(dir, "package.json"), '{"type":"module"}')
    write(
      join(dir, "tsconfig.entrypoint.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          types: [],
        },
        include: ["index.ts"],
      }),
    )
    const host = join(dir, "host")
    write(
      join(host, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        types: "index.d.ts",
        type: "module",
      }),
    )
    write(join(host, "index.d.ts"), "export type HostValue = number")
    const ai = join(host, "node_modules/@earendil-works/pi-ai")
    write(
      join(ai, "package.json"),
      JSON.stringify({
        type: "module",
        exports: { ".": { types: "./index.d.ts" }, "./compat": { types: "./compat.d.ts" } },
      }),
    )
    write(join(ai, "index.d.ts"), 'export type RootValue = "root"')
    write(join(ai, "compat.d.ts"), 'export type CompatValue = "compat"')
    const valid =
      'import type { HostValue } from "@earendil-works/pi-coding-agent"; import type { RootValue } from "@earendil-works/pi-ai"; import type { CompatValue } from "@earendil-works/pi-ai/compat"; const host: HostValue = 1; const root: RootValue = "root"; const compat: CompatValue = "compat";'
    write(join(dir, "index.ts"), valid)
    assert.deepEqual(entrypointProgram(host, dir).diagnostics, [])
    write(join(dir, "index.ts"), valid.replace("HostValue = 1", 'HostValue = "wrong"'))
    const { diagnostics } = entrypointProgram(host, dir)
    assert.ok(
      diagnostics.some((d) => d.code === 2322 && d.file?.fileName === join(dir, "index.ts")),
    )
    write(join(ai, "compat.d.ts"), 'export type CompatValue = "changed-host-contract"')
    assert.ok(entrypointProgram(host, dir).diagnostics.filter((d) => d.code === 2322).length >= 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ordinary unit typecheck keeps the optional-host boundary explicit", () => {
  const config = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"))
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root)
  assert.ok(!parsed.fileNames.includes(join(root, "tests/types/entrypoint.ts")))
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")
  assert.match(
    ci,
    /npm run typecheck:entrypoint -- "\$\(npm root -g\)\/@earendil-works\/pi-coding-agent"/,
  )
})
