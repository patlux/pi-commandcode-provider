import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { isAbsolute, join } from "node:path"

const root = fileURLToPath(new URL("../", import.meta.url))
const sdk = join(root, "packages/pig-commandcode-provider/third_party/pig-sdk")
const manifest = JSON.parse(await readFile(join(root, "patches/pig/sdk-snapshot.json"), "utf8"))
async function files(directory, prefix = "") {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`
    assert.ok(!entry.isSymbolicLink(), `SDK snapshot symlink: ${name}`)
    if (entry.isDirectory()) result.push(...(await files(join(directory, entry.name), `${name}/`)))
    else if (name !== "PROVENANCE.md") result.push(name)
  }
  return result.sort()
}
assert.deepEqual(await files(sdk), Object.keys(manifest.files).sort(), "SDK snapshot file drift")
for (const [name, digest] of Object.entries(manifest.files)) {
  const actual = createHash("sha256")
    .update(await readFile(join(sdk, name)))
    .digest("hex")
  assert.equal(actual, digest, `SDK snapshot changed without reviewed provenance: ${name}`)
}
if (process.argv[2]) {
  assert.ok(isAbsolute(process.argv[2]), "Supply an absolute patched PiG checkout path")
  for (const [name, digest] of Object.entries(manifest.files)) {
    const source = await readFile(join(process.argv[2], manifest.sourceDirectory, name))
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      digest,
      `Bundled SDK differs from patched source: ${name}`,
    )
  }
}
console.log(`PASS package-owned SDK snapshot (${Object.keys(manifest.files).length} files)`)
