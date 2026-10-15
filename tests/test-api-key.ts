import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { defaultAuthPaths, getConfiguredApiKey } from "../src/api-key.ts"
import { getApiKey as getGenerateApiKey } from "../src/core.ts"

async function withAuthFile(
  value: unknown,
  run: (authPath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-commandcode-auth-"))
  const authPath = join(directory, "auth.json")
  try {
    await writeFile(authPath, JSON.stringify(value), "utf-8")
    await run(authPath)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("getConfiguredApiKey()", () => {
  it("prefers the official environment variable and keeps the legacy alias", () => {
    assert.equal(
      getConfiguredApiKey({
        env: { COMMAND_CODE_API_KEY: "official-key", COMMANDCODE_API_KEY: "legacy-key" },
        authPaths: [],
      }),
      "official-key",
    )
    assert.equal(
      getConfiguredApiKey({ env: { COMMANDCODE_API_KEY: "legacy-key" }, authPaths: [] }),
      "legacy-key",
    )
  })

  it("reads pi OAuth and API credentials", async () => {
    const cases: readonly { credential: unknown; expected: string }[] = [
      {
        credential: { commandcode: { type: "oauth", access: "oauth-key" } },
        expected: "oauth-key",
      },
      { credential: { commandcode: { type: "api", key: "api-key" } }, expected: "api-key" },
      { credential: { "command-code": { type: "api", key: "cli-key" } }, expected: "cli-key" },
      { credential: { "command-code": "cli-string-key" }, expected: "cli-string-key" },
      { credential: { commandcode: "legacy-string-key" }, expected: "legacy-string-key" },
      { credential: { apiKey: "legacy-key" }, expected: "legacy-key" },
    ]

    for (const testCase of cases) {
      await withAuthFile(testCase.credential, async (authPath) => {
        assert.equal(getConfiguredApiKey({ env: {}, authPaths: [authPath] }), testCase.expected)
      })
    }
  })

  it("is the reader the generate transport uses", () => {
    // Both transports must agree on auth-file precedence and credential shapes.
    assert.equal(getGenerateApiKey, getConfiguredApiKey)
  })

  it("consults auth files in the documented order", () => {
    assert.deepEqual(defaultAuthPaths("/home/user", {}), [
      join("/home/user", ".commandcode", "auth.json"),
      join("/home/user", ".pi", "agent", "auth.json"),
      join("/home/user", ".omp", "agent", "auth.json"),
    ])
  })

  it("reads the pi auth file from PI_CODING_AGENT_DIR instead of the default profile", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-commandcode-home-"))
    const profileDir = await mkdtemp(join(tmpdir(), "pi-commandcode-profile-"))
    try {
      await mkdir(join(home, ".pi", "agent"), { recursive: true })
      await writeFile(
        join(home, ".pi", "agent", "auth.json"),
        JSON.stringify({ commandcode: { type: "api", key: "default-profile-key" } }),
        "utf-8",
      )
      await writeFile(
        join(profileDir, "auth.json"),
        JSON.stringify({ commandcode: { type: "api", key: "profile-key" } }),
        "utf-8",
      )

      assert.equal(getConfiguredApiKey({ env: {}, homeDir: () => home }), "default-profile-key")
      assert.equal(
        getConfiguredApiKey({ env: { PI_CODING_AGENT_DIR: profileDir }, homeDir: () => home }),
        "profile-key",
      )
      // An isolated profile without credentials must not fall back to another profile.
      await rm(join(profileDir, "auth.json"))
      assert.equal(
        getConfiguredApiKey({ env: { PI_CODING_AGENT_DIR: profileDir }, homeDir: () => home }),
        undefined,
      )
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(profileDir, { recursive: true, force: true })
    }
  })

  it("ignores malformed files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-commandcode-auth-"))
    const authPath = join(directory, "auth.json")
    try {
      await writeFile(authPath, "not json", "utf-8")
      assert.equal(getConfiguredApiKey({ env: {}, authPaths: [authPath] }), undefined)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
