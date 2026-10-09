import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const supplied = process.argv[2]
assert.ok(
  supplied && isAbsolute(supplied),
  "Supply the absolute path to a disposable pinned PiG checkout",
)
const checkout = await realpath(supplied)
const patchRoot = fileURLToPath(new URL("../patches/pig/", import.meta.url))
const manifest = JSON.parse(await readFile(resolve(patchRoot, "series.json"), "utf8"))
const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
assert.equal(
  await realpath(git("rev-parse", "--show-toplevel").trim()),
  checkout,
  "Expected checkout root",
)
assert.equal(
  git("rev-parse", "HEAD").trim(),
  manifest.baseRevision,
  "PiG revision differs from patch base",
)
assert.equal(git("status", "--porcelain").trim(), "", "Refuse to patch a dirty checkout")
const paths = []
for (const patch of manifest.patches) {
  const path = resolve(patchRoot, patch.file)
  assert.equal(
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
    patch.sha256,
    "Patch digest mismatch",
  )
  paths.push(path)
}
git("apply", "--check", ...paths)
git("apply", ...paths)
console.log(
  `Applied ${manifest.patches.length} reviewed patches to ${checkout}; regenerate the Node runtime before building`,
)
