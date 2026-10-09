import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { PIG_REVISION } from "./helpers/pig-process.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const apply = fileURLToPath(new URL("../scripts/apply-pig-patches.mjs", import.meta.url))

test("patch manifest matches the host pin and parseable patch contents", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../patches/pig/series.json", import.meta.url), "utf8"),
  )
  assert.equal(manifest.baseRevision, PIG_REVISION)
  assert.equal(manifest.patches.length, 4)
  for (const patch of manifest.patches) {
    assert.match(patch.file, /^\d{4}-[a-z-]+\.patch$/)
    const path = fileURLToPath(new URL(`../patches/pig/${patch.file}`, import.meta.url))
    const bytes = await readFile(path)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), patch.sha256)
    assert.ok(
      execFileSync("git", ["apply", "--numstat", path], { cwd: root, encoding: "utf8" }).trim(),
    )
  }
})

test("patch application refuses absent, relative, and wrong-repository targets", () => {
  for (const args of [[], ["."], [root]]) {
    const result = spawnSync(process.execPath, [apply, ...args], { cwd: root, encoding: "utf8" })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Supply the absolute path|PiG revision differs from patch base/)
  }
})

test("bundled SDK matches its reviewed snapshot manifest", () => {
  const script = fileURLToPath(new URL("../scripts/check-pig-sdk.mjs", import.meta.url))
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PASS package-owned SDK snapshot/)
})
