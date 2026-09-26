import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  parseReleaseTag,
  validateRelease,
  checkPackageFiles,
  registryDecision,
  compareVersions,
} from "../.github/scripts/release.mjs"

const manifest = {
  name: "pi-commandcode-provider",
  version: "0.8.0",
  repository: { url: "git+https://github.com/patlux/pi-commandcode-provider.git" },
  files: [
    "index.ts",
    "src/",
    "scripts/",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "RELEASE.md",
    "LICENSE",
  ],
}
const lock = {
  name: manifest.name,
  version: manifest.version,
  packages: { "": { name: manifest.name, version: manifest.version } },
}
const changelog =
  "# Changelog\n\n## Unreleased\n\n## 0.8.0 - 2026-09-26\n\n- Fix a bug.\n\n### Contributors\n\n- @contributor — reported it.\n\n## 0.7.2 - 2026-09-24\n\n- Previous release.\n"
const validate = (overrides = {}) =>
  validateRelease({ tag: "v0.8.0", manifest, lock, changelog, ...overrides })
const artifact = { version: "0.8.0", distTag: "latest", integrity: "sha512-example" }
const registry = (version = "0.7.2", published) => ({
  "dist-tags": { latest: version },
  versions: published ? { "0.8.0": { dist: { integrity: published } } } : {},
})

describe("release versions", () => {
  it("maps stable and next tags explicitly", () => {
    assert.deepEqual(parseReleaseTag("v0.8.0"), { version: "0.8.0", distTag: "latest" })
    assert.deepEqual(parseReleaseTag("v0.8.0-next.1"), {
      version: "0.8.0-next.1",
      distTag: "next",
    })
  })
  for (const tag of [
    "0.8.0",
    "v0.8",
    "v01.2.3",
    "v1.2.3-beta.1",
    "v1.2.3-next",
    "v1.2.3-next.01",
    "v1.2.3+build",
    "v1.2.3\n",
    "v1.2.3;echo bad",
    "v9007199254740992.0.0",
  ]) {
    it(`rejects ${JSON.stringify(tag)}`, () => assert.throws(() => parseReleaseTag(tag)))
  }
  it("compares numbers, not strings, and handles prerelease promotion", () => {
    assert.equal(compareVersions("0.10.0", "0.9.0"), 1)
    assert.equal(compareVersions("0.8.0", "0.8.0-next.9"), 1)
    assert.equal(compareVersions("0.8.0-next.10", "0.8.0-next.9"), 1)
    assert.equal(compareVersions("0.8.0-next.1", "0.8.0"), -1)
    assert.equal(compareVersions("0.8.0", "0.8.0"), 0)
  })
})

describe("release contract", () => {
  it("extracts only the tagged changelog section, including contributors", () => {
    const result = validate()
    assert.equal(result.version, "0.8.0")
    assert.match(result.notes, /@contributor/)
    assert.doesNotMatch(result.notes, /Previous release|Unreleased/)
  })
  it("rejects a mismatched package version", () => {
    assert.throws(() => validate({ tag: "v0.9.0" }), /version/)
  })
  it("checks both lockfile versions and package names", () => {
    assert.throws(() => validate({ lock: { ...lock, version: "0.7.2" } }), /lockfile/)
    assert.throws(
      () => validate({ lock: { ...lock, packages: { "": { ...manifest, version: "0.7.2" } } } }),
      /lockfile/,
    )
    assert.throws(() => validate({ lock: { ...lock, name: "other-package" } }), /lockfile/)
  })
  it("rejects a different package, repository, or private package", () => {
    for (const change of [
      { name: "wrong-package" },
      { repository: { url: "https://github.com/someone/fork" } },
      { private: true },
      { publishConfig: { registry: "https://other.example" } },
      { publishConfig: { provenance: false } },
    ])
      assert.throws(() => validate({ manifest: { ...manifest, ...change } }))
  })
  it("requires exactly one nonempty, dated changelog section", () => {
    for (const text of [
      "## Unreleased\n",
      "## 0.8.0\n- Fix\n",
      "## 0.8.0 - 2026-09-26\n\n",
      changelog + changelog,
    ]) {
      assert.throws(() => validate({ changelog: text }), /changelog/i)
    }
  })
})

describe("package contents", () => {
  const files = [
    "package.json",
    "index.ts",
    "src/core.ts",
    "scripts/pi-isolated.mjs",
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "RELEASE.md",
  ]
  it("accepts the package's runtime and documentation files", () => {
    assert.doesNotThrow(() => checkPackageFiles(files))
  })
  for (const file of [
    ".env",
    "src/.env",
    "src/auth.json",
    "src/key.pem",
    "node_modules/x.js",
    "tests/fixture.ts",
    ".github/workflows/release.yml",
    "src/../secret.ts",
  ]) {
    it(`rejects unexpected packaged file ${file}`, () => {
      assert.throws(() => checkPackageFiles([...files, file]), /Unexpected/)
    })
  }
  it("requires the extension entrypoint and manifest", () => {
    assert.throws(() => checkPackageFiles(["README.md"]), /Missing/)
  })
})

describe("git release guards", () => {
  const script = fileURLToPath(new URL("../.github/scripts/release.mjs", import.meta.url))
  function fixture(test) {
    const directory = mkdtempSync(join(tmpdir(), "cc-release-guards-"))
    const origin = join(directory, "origin")
    const checkout = join(directory, "checkout")
    const git = (cwd, ...args) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    try {
      mkdirSync(origin)
      git(origin, "init", "--initial-branch=main")
      git(origin, "config", "user.name", "Release Test")
      git(origin, "config", "user.email", "release-test@example.invalid")
      git(origin, "config", "commit.gpgsign", "false")
      git(origin, "config", "tag.gpgsign", "false")
      writeFileSync(join(origin, "package.json"), JSON.stringify(manifest))
      writeFileSync(join(origin, "package-lock.json"), JSON.stringify(lock))
      writeFileSync(join(origin, "CHANGELOG.md"), changelog)
      for (const file of ["README.md", "CONTRIBUTING.md", "RELEASE.md", "LICENSE", "index.ts"]) {
        writeFileSync(join(origin, file), "// release fixture\n")
      }
      mkdirSync(join(origin, "src"))
      writeFileSync(join(origin, "src", "core.ts"), "export const fixture = true\n")
      git(origin, "add", ".")
      git(origin, "commit", "-m", "fixture")
      const sha = git(origin, "rev-parse", "HEAD")
      git(origin, "tag", "v0.8.0")
      git(directory, "clone", "--no-local", origin, checkout)
      const env = {
        ...process.env,
        GITHUB_REPOSITORY: "patlux/pi-commandcode-provider",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: "v0.8.0",
        GITHUB_SHA: sha,
        GITHUB_OUTPUT: join(directory, "outputs"),
      }
      const cli = (command, changes = {}) =>
        spawnSync(process.execPath, [script, command], {
          cwd: checkout,
          env: { ...env, ...changes },
          encoding: "utf8",
        })
      const validateCli = (changes = {}) => cli("validate", changes)
      test({ origin, checkout, git, validateCli, cli, sha, env })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  it("validates a lightweight tag in main and emits safe outputs", () =>
    fixture(({ validateCli, env }) => {
      const result = validateCli()
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "version=0.8.0\ndist_tag=latest\n")
    }))
  it("packs reproducibly, records SHA-512 and excludes release artifacts on a rerun", () =>
    fixture(({ checkout, cli }) => {
      const first = cli("pack")
      assert.equal(first.status, 0, first.stderr)
      const directory = join(checkout, "release-artifact")
      const artifact = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"))
      const bytes = readFileSync(join(directory, artifact.filename))
      assert.equal(
        artifact.integrity,
        `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      )
      assert.match(readFileSync(join(directory, "notes.md"), "utf8"), /@contributor/)
      const second = cli("pack")
      assert.equal(second.status, 0, second.stderr)
      assert.deepEqual(readFileSync(join(directory, artifact.filename)), bytes)
    }))
  it("rejects a tampered tarball before any registry access", () =>
    fixture(({ checkout, cli }) => {
      const packed = cli("pack")
      assert.equal(packed.status, 0, packed.stderr)
      writeFileSync(
        join(checkout, "release-artifact", "pi-commandcode-provider-0.8.0.tgz"),
        "tampered",
      )
      const result = cli("registry-check")
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Artifact checksum mismatch/)
    }))
  it("rejects mismatching artifact metadata before registry access", () =>
    fixture(({ checkout, cli }) => {
      const packed = cli("pack")
      assert.equal(packed.status, 0, packed.stderr)
      const path = join(checkout, "release-artifact", "release.json")
      const artifact = JSON.parse(readFileSync(path, "utf8"))
      writeFileSync(path, JSON.stringify({ ...artifact, commit: "0".repeat(40) }))
      const result = cli("registry-check")
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Artifact commit mismatch/)
    }))
  it("accepts an annotated tag pointing at the same commit", () =>
    fixture(({ origin, git, validateCli }) => {
      git(origin, "tag", "-f", "-a", "v0.8.0", "-m", "release")
      assert.equal(validateCli().status, 0)
    }))
  it("rejects a deleted remote tag", () =>
    fixture(({ origin, git, validateCli }) => {
      git(origin, "tag", "-d", "v0.8.0")
      const result = validateCli()
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /moved or deleted/)
    }))
  it("rejects a moved remote tag", () =>
    fixture(({ origin, git, validateCli }) => {
      git(origin, "commit", "--allow-empty", "-m", "later")
      git(origin, "tag", "-f", "v0.8.0")
      const result = validateCli()
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /moved or deleted/)
    }))
  it("rejects a tag outside main even if the local checkout matches it", () =>
    fixture(({ origin, checkout, git, validateCli }) => {
      git(origin, "switch", "-c", "unmerged")
      git(origin, "commit", "--allow-empty", "-m", "unmerged")
      const sha = git(origin, "rev-parse", "HEAD")
      git(origin, "tag", "-f", "v0.8.0")
      git(checkout, "fetch", "origin", "unmerged")
      git(checkout, "checkout", "--detach", sha)
      const result = validateCli({ GITHUB_SHA: sha })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /merge-base/)
    }))
  it("rejects tracked modifications", () =>
    fixture(({ checkout, validateCli }) => {
      writeFileSync(join(checkout, "CHANGELOG.md"), changelog + "\nmodified\n")
      const result = validateCli()
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /tracked changes/)
    }))
  it("rejects forks, branch runs and non-push events", () =>
    fixture(({ validateCli }) => {
      for (const changes of [
        { GITHUB_REPOSITORY: "someone/fork" },
        { GITHUB_REF_TYPE: "branch" },
        { GITHUB_EVENT_NAME: "workflow_dispatch" },
      ])
        assert.notEqual(validateCli(changes).status, 0)
    }))
  it("rejects a mismatching event SHA", () =>
    fixture(({ origin, checkout, git, validateCli }) => {
      git(origin, "commit", "--allow-empty", "-m", "later")
      const sha = git(origin, "rev-parse", "HEAD")
      git(checkout, "fetch", "origin", "main")
      const result = validateCli({ GITHUB_SHA: sha })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /event SHA/)
    }))
})

describe("registry recovery", () => {
  it("publishes a new version", () => {
    assert.equal(registryDecision(artifact, registry()), "publish")
  })
  it("continues a partial release only for byte-identical published content", () => {
    assert.equal(registryDecision(artifact, registry("0.8.0", artifact.integrity)), "existing")
  })
  it("rejects an existing version with different or absent integrity", () => {
    assert.throws(() => registryDecision(artifact, registry("0.8.0", "sha512-other")), /integrity/)
    assert.throws(
      () =>
        registryDecision(artifact, { "dist-tags": { latest: "0.8.0" }, versions: { "0.8.0": {} } }),
      /integrity/,
    )
  })
  it("does not mistake a malformed registry response for an unpublished version", () => {
    assert.throws(() => registryDecision(artifact, {}), /registry/i)
  })
  it("never rolls back latest or next", () => {
    assert.throws(() => registryDecision(artifact, registry("0.9.0")), /backwards/)
    assert.throws(
      () =>
        registryDecision(
          { ...artifact, version: "0.8.0-next.1", distTag: "next" },
          { "dist-tags": { next: "0.8.0-next.2" }, versions: {} },
        ),
      /backwards/,
    )
  })
  it("does not silently repair dist-tags on reruns", () => {
    assert.throws(
      () => registryDecision(artifact, registry("0.7.2", artifact.integrity)),
      /dist-tag/,
    )
  })
  it("never overwrites stable latest with a prerelease", () => {
    assert.equal(
      registryDecision(
        { ...artifact, version: "0.9.0-next.1", distTag: "next" },
        { "dist-tags": { latest: "0.8.0", next: "0.1.1-next.0" }, versions: {} },
      ),
      "publish",
    )
  })
})
