import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  describeZdr,
  readZdrSetting,
  resolveZdr,
  saveZdrSetting,
  zdrEnvVar,
  zdrHeaders,
} from "../src/zdr.ts"

async function isolated(run: (path: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-commandcode-zdr-"))
  try {
    await run(join(dir, "settings.json"), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("zero data retention resolution", () => {
  it("accepts only the documented env values and keeps the legacy alias", () => {
    assert.equal(zdrEnvVar({ CMD_ZDR: "1" }), "CMD_ZDR")
    assert.equal(zdrEnvVar({ COMMANDCODE_ZDR: "1" }), "COMMANDCODE_ZDR")
    assert.equal(zdrEnvVar({ CMD_ZDR: "1", COMMANDCODE_ZDR: "1" }), "CMD_ZDR")
    for (const value of ["0", "true", "yes", " 1", "1 ", ""]) {
      assert.equal(zdrEnvVar({ CMD_ZDR: value }), undefined, `CMD_ZDR=${JSON.stringify(value)}`)
    }
  })

  it("reads only a literal boolean true from settings.json", () => {
    assert.equal(readZdrSetting({ commandcode: { enableZDR: true } }), true)
    assert.equal(readZdrSetting({ commandcode: { enableZDR: false } }), false)
    for (const value of ["true", 1, null, {}, []]) {
      assert.equal(
        readZdrSetting({ commandcode: { enableZDR: value } }),
        false,
        `enableZDR=${JSON.stringify(value)}`,
      )
    }
    assert.equal(readZdrSetting({}), false)
    assert.equal(readZdrSetting(undefined), false)
    assert.equal(readZdrSetting({ commandcode: true }), false)
  })

  it("lets the environment override a settings file that turns ZDR off", () => {
    const off = { commandcode: { enableZDR: false } }
    assert.deepEqual(resolveZdr(off, { CMD_ZDR: "1" }), {
      enabled: true,
      source: "env",
      envVar: "CMD_ZDR",
    })
    assert.deepEqual(resolveZdr({ commandcode: { enableZDR: true } }, { CMD_ZDR: "1" }), {
      enabled: true,
      source: "env",
      envVar: "CMD_ZDR",
    })
  })

  it("resolves settings, off, headers and their descriptions", () => {
    const settings = resolveZdr({ commandcode: { enableZDR: true } }, {})
    assert.deepEqual(settings, { enabled: true, source: "settings" })
    assert.deepEqual(zdrHeaders(settings), { "x-cmd-zdr": "1" })
    assert.match(describeZdr(settings), /^on \(settings\.json/)

    const env = resolveZdr({}, { COMMANDCODE_ZDR: "1" })
    assert.equal(describeZdr(env), "on (COMMANDCODE_ZDR)")

    const off = resolveZdr({}, {})
    assert.deepEqual(off, { enabled: false, source: "off" })
    assert.equal(zdrHeaders(off), undefined)
    assert.equal(describeZdr(off), "off")
  })
})

describe("saving the settings.json opt-in", () => {
  it("creates settings.json and keeps every unrelated key", async () => {
    await isolated(async (path, dir) => {
      const written = await saveZdrSetting(path, true)
      assert.equal(resolveZdr(written, {}).enabled, true)
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
        commandcode: { enableZDR: true },
      })
      assert.equal((await stat(path)).mode & 0o777, 0o600)

      const existing = {
        theme: "matte-black",
        terminal: { hideImages: false },
        commandcode: { endpoint: "responses" },
      }
      await writeFile(path, JSON.stringify(existing), "utf8")
      const updated = await saveZdrSetting(path, true)
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
        ...existing,
        commandcode: { endpoint: "responses", enableZDR: true },
      })
      assert.equal(resolveZdr(updated, {}).enabled, true)

      const disabled = await saveZdrSetting(path, false)
      assert.equal(resolveZdr(disabled, {}).enabled, false)
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
        ...existing,
        commandcode: { endpoint: "responses", enableZDR: false },
      })
    })
  })

  it("creates the agent directory when it does not exist", async () => {
    await isolated(async (_path, dir) => {
      const nested = join(dir, "agent", "settings.json")
      await saveZdrSetting(nested, true)
      assert.deepEqual(JSON.parse(await readFile(nested, "utf8")), {
        commandcode: { enableZDR: true },
      })
    })
  })

  it("refuses to overwrite a malformed or non-object settings file", async () => {
    await isolated(async (path) => {
      for (const content of ["{ not json", "[]", "null", '"text"']) {
        await writeFile(path, content, "utf8")
        await assert.rejects(() => saveZdrSetting(path, true), /settings\.json/)
        assert.equal(await readFile(path, "utf8"), content)
      }
    })
  })
})
