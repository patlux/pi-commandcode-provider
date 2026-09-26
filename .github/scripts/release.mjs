import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

export const PACKAGE = "pi-commandcode-provider"
const REPOSITORY = "patlux/pi-commandcode-provider"
const REGISTRY = `https://registry.npmjs.org/${PACKAGE}`
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.(0|[1-9]\d*))?$/

function versionParts(version) {
  const match = VERSION.exec(version)
  assert.ok(match && match[0] === version, `Unsupported version: ${version}`)
  const parts = match.slice(1).map((part) => (part === undefined ? undefined : Number(part)))
  assert.ok(
    parts.every((part) => part === undefined || Number.isSafeInteger(part)),
    "Version exceeds safe integer range",
  )
  return parts
}

export function parseReleaseTag(tag) {
  assert.ok(typeof tag === "string" && tag.startsWith("v"), "Expected a v-prefixed release tag")
  const version = tag.slice(1)
  const parts = versionParts(version)
  return { version, distTag: parts[3] === undefined ? "latest" : "next" }
}

export function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let i = 0; i < 4; i++) {
    const x = a[i] ?? Infinity
    const y = b[i] ?? Infinity
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

export function validateRelease({ tag, manifest, lock, changelog }) {
  const release = parseReleaseTag(tag)
  assert.equal(manifest.name, PACKAGE, "Unexpected package name")
  assert.notEqual(manifest.private, true, "Cannot publish a private package")
  // No alternate registry, access, dist-tag or provenance overrides in the tarball.
  assert.ok(!manifest.publishConfig, "Release workflow owns publishConfig")
  assert.equal(
    manifest.repository?.url,
    `git+https://github.com/${REPOSITORY}.git`,
    "Unexpected repository",
  )
  assert.equal(manifest.version, release.version, "Tag and package version differ")
  for (const entry of [lock, lock.packages?.[""]]) {
    assert.equal(entry?.version, release.version, "Tag and lockfile version differ")
    assert.equal(entry?.name, PACKAGE, "Unexpected lockfile package name")
  }
  const sections = changelog.split(/^## /m).slice(1)
  const matches = sections.filter((section) =>
    section.split("\n")[0].startsWith(`${release.version} - `),
  )
  assert.equal(matches.length, 1, "Expected exactly one dated changelog section")
  const [heading, ...body] = matches[0].split("\n")
  assert.match(heading, /^\S+ - \d{4}-\d{2}-\d{2}$/, "Expected a dated changelog heading")
  const notes = body.join("\n").trim()
  assert.ok(notes.length > 0, "Release changelog must not be empty")
  return { ...release, notes }
}

export function checkPackageFiles(files) {
  const rootFiles = new Set([
    "package.json",
    "index.ts",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "RELEASE.md",
    "LICENSE",
  ])
  for (const file of files) {
    const allowedSource = /^(src|scripts)\/[\w/-]+\.(ts|mjs)$/.test(file)
    assert.ok(rootFiles.has(file) || allowedSource, `Unexpected package file: ${file}`)
  }
  for (const required of rootFiles)
    assert.ok(files.includes(required), `Missing package file: ${required}`)
  assert.ok(
    files.some((file) => file.startsWith("src/")),
    "Missing package runtime sources",
  )
}

export function registryDecision(artifact, metadata) {
  assert.ok(
    metadata &&
      typeof metadata.versions === "object" &&
      metadata.versions !== null &&
      typeof metadata["dist-tags"] === "object" &&
      metadata["dist-tags"] !== null,
    "Malformed registry metadata",
  )
  const current = metadata["dist-tags"][artifact.distTag]
  if (current)
    assert.ok(
      compareVersions(artifact.version, current) >= 0,
      `Refusing to move ${artifact.distTag} backwards from ${current}`,
    )
  const published = metadata.versions[artifact.version]
  if (!published) return "publish"
  assert.equal(
    published.dist?.integrity,
    artifact.integrity,
    "Existing version has different/missing integrity; do not republish",
  )
  assert.equal(
    current,
    artifact.version,
    "Published version does not match its dist-tag; manual investigation required",
  )
  return "existing"
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  }).trim()
}
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}
function integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`
}
function output(values) {
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(values))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  }
}
function plan() {
  assert.equal(
    process.env.GITHUB_REPOSITORY,
    REPOSITORY,
    "Release must run in the canonical repository",
  )
  assert.equal(process.env.GITHUB_REF_TYPE, "tag", "Releases require a tag push")
  assert.equal(process.env.GITHUB_EVENT_NAME, "push", "Releases require a tag push")
  const tag = process.env.GITHUB_REF_NAME
  const release = validateRelease({
    tag,
    manifest: readJson("package.json"),
    lock: readJson("package-lock.json"),
    changelog: readFileSync("CHANGELOG.md", "utf8"),
  })
  assert.equal(
    run("git", ["status", "--porcelain", "--untracked-files=no"]),
    "",
    "Release checkout has tracked changes",
  )
  const commit = run("git", ["rev-parse", "HEAD"])
  assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/)
  assert.equal(
    commit,
    run("git", ["rev-parse", `${process.env.GITHUB_SHA}^{commit}`]),
    "Checkout must match event SHA",
  )
  // Fetch fresh refs, not just a potentially stale checkout's origin/main.
  run("git", ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"])
  run("git", ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"])
  const remote = run("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
  const refs = new Map(
    remote
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/)
        return [ref, sha]
      }),
  )
  assert.equal(
    refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`),
    commit,
    "Release tag was moved or deleted",
  )
  return { ...release, tag, commit }
}
async function registry() {
  const response = await fetch(REGISTRY, { signal: AbortSignal.timeout(30_000) })
  assert.ok(
    response.ok,
    `Registry lookup failed: HTTP ${response.status}; refusing to assume the version is absent`,
  )
  return response.json()
}
function readArtifact(directory) {
  const artifact = readJson(resolve(directory, "release.json"))
  const release = plan()
  for (const key of ["version", "distTag", "tag", "commit"])
    assert.equal(artifact[key], release[key], `Artifact ${key} mismatch`)
  assert.equal(
    artifact.filename,
    `${PACKAGE}-${release.version}.tgz`,
    "Unexpected artifact filename",
  )
  assert.equal(
    integrity(readFileSync(resolve(directory, artifact.filename))),
    artifact.integrity,
    "Artifact checksum mismatch",
  )
  return artifact
}

async function main() {
  const [command, directory = "release-artifact"] = process.argv.slice(2)
  if (command === "validate") {
    const release = plan()
    output({ version: release.version, dist_tag: release.distTag })
    console.log(`Validated ${release.tag} at ${release.commit}`)
  } else if (command === "pack") {
    const release = plan()
    mkdirSync(directory, { recursive: true })
    const [packed] = JSON.parse(
      run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", resolve(directory)]),
    )
    assert.equal(packed.name, PACKAGE)
    assert.equal(packed.version, release.version)
    assert.equal(packed.filename, `${PACKAGE}-${release.version}.tgz`)
    checkPackageFiles(packed.files.map((file) => file.path))
    const checksum = integrity(readFileSync(resolve(directory, packed.filename)))
    assert.equal(checksum, packed.integrity)
    const artifact = { ...release, filename: packed.filename, integrity: checksum }
    writeFileSync(resolve(directory, "release.json"), `${JSON.stringify(artifact, null, 2)}\n`)
    const notes = `${release.notes}\n\n### Validation\n\n- Release CI and packed/registry package tests with real Pi and OMP against mock APIs.\n- No live Command Code account test is performed by this workflow.\n- Commit: ${release.commit}\n- [Release workflow](https://github.com/${REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID})\n`
    writeFileSync(resolve(directory, "notes.md"), notes)
    output({ tarball: resolve(directory, packed.filename) })
    console.log(`Packed ${packed.filename}: ${checksum}`)
  } else if (command === "registry-check") {
    const artifact = readArtifact(directory)
    const decision = registryDecision(artifact, await registry())
    output({ decision, tarball: resolve(directory, artifact.filename), dist_tag: artifact.distTag })
    console.log(`Registry decision: ${decision}`)
  } else if (command === "verify") {
    const artifact = readArtifact(directory)
    let metadata
    for (let attempt = 0; attempt < 6; attempt++) {
      metadata = await registry()
      if (
        metadata.versions?.[artifact.version] &&
        metadata["dist-tags"]?.[artifact.distTag] === artifact.version
      )
        break
      if (attempt < 5) await delay(5_000)
    }
    assert.equal(
      registryDecision(artifact, metadata),
      "existing",
      "Published version not visible in registry",
    )
    const url = new URL(metadata.versions[artifact.version].dist.tarball)
    assert.equal(url.origin, "https://registry.npmjs.org", "Unexpected registry tarball origin")
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" })
    assert.ok(response.ok, `Registry tarball download failed: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(
      integrity(bytes),
      artifact.integrity,
      "Registry tarball differs from tested artifact",
    )
    const path = resolve(directory, "registry-package.tgz")
    writeFileSync(path, bytes)
    output({ tarball: path })
    console.log(`Verified public npm ${PACKAGE}@${artifact.version} and ${artifact.distTag}`)
  } else if (command === "github") {
    const artifact = readArtifact(directory)
    assert.equal(registryDecision(artifact, await registry()), "existing")
    // Listing fails closed on API/auth errors. A duplicate outside this window causes
    // create to fail safely, never an automatic overwrite of another release.
    const releases = JSON.parse(
      run("gh", [
        "release",
        "list",
        "--repo",
        REPOSITORY,
        "--limit",
        "100",
        "--json",
        "tagName,isDraft,isPrerelease",
      ]),
    )
    const existing = releases.find((release) => release.tagName === artifact.tag)
    if (existing) {
      assert.equal(existing.isDraft, false, "Existing release is still a draft")
      assert.equal(
        existing.isPrerelease,
        artifact.distTag === "next",
        "Existing release type mismatch",
      )
      console.log(`GitHub release ${artifact.tag} already exists; leaving it unchanged`)
      return
    }
    const args = [
      "release",
      "create",
      artifact.tag,
      "--repo",
      REPOSITORY,
      "--verify-tag",
      "--title",
      `${PACKAGE} ${artifact.version}`,
      "--notes-file",
      resolve(directory, "notes.md"),
    ]
    if (artifact.distTag === "next") args.push("--prerelease", "--latest=false")
    else args.push("--latest")
    run("gh", args)
    console.log(`Created GitHub release ${artifact.tag}`)
  } else {
    throw new Error(
      `Unknown release command: ${command}; expected validate, pack, registry-check, verify, or github`,
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
