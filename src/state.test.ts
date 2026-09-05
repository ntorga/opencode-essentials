import { describe, it, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FeatureId } from "./valueObject/featureId.ts"
import { newFeatureId } from "./valueObject/featureId.ts"
import type { IdleTimeoutMs } from "./valueObject/idleTimeoutMs.ts"
import { newIdleTimeoutMs } from "./valueObject/idleTimeoutMs.ts"
import {
  resolveEffectiveIdleTimeoutMs,
  isFeatureEnabled,
  readEssentialsConfig,
  resolveEssentialsStatePath,
  writeFeatureEnabled,
  writeGlobalEnabled,
  writeIdleTimeoutMs,
  clearIdleTimeoutMs,
} from "./state.ts"

// Note: Setup/teardown are intentionally inline — test independence
// requires each file to own its preconditions, even if it duplicates code.

function trustedFeatureId(id: string): FeatureId {
  const validated = newFeatureId(id)
  if (!validated) throw new Error(`TestFixtureFeatureIdInvalid: ${id}`)
  return validated
}

function trustedTimeout(ms: number): IdleTimeoutMs {
  const timeout = newIdleTimeoutMs(ms)
  if (!timeout) throw new Error(`TestFixtureTimeoutInvalid: ${ms}`)
  return timeout
}

function writeRawState(contents: string) {
  mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
  writeFileSync(resolveEssentialsStatePath(), contents)
}

let dataHomeTemp = ""
let previousDataHome: string | undefined

beforeEach(() => {
  previousDataHome = process.env["XDG_DATA_HOME"]
  dataHomeTemp = mkdtempSync(path.join(tmpdir(), "essentials-state-"))
  process.env["XDG_DATA_HOME"] = dataHomeTemp
})

afterEach(() => {
  process.env["XDG_DATA_HOME"] = previousDataHome ?? ""
  rmSync(dataHomeTemp, { recursive: true, force: true })
})

describe("essentials config file", () => {
  it("returns defaults with no error when no file exists", () => {
    const configRead = readEssentialsConfig()
    assert.equal(configRead.error, undefined)
    assert.equal(configRead.config.isEnabled, true)
    assert.deepEqual({ ...configRead.config.states }, {})
    assert.equal(
      isFeatureEnabled(configRead.config, trustedFeatureId("any")),
      true,
    )
  })

  it("round-trips toggles through the file", () => {
    writeFeatureEnabled(trustedFeatureId("idle-auto-compactor"), false)
    writeFeatureEnabled(trustedFeatureId("exec-guard"), true)
    const config = readEssentialsConfig().config
    assert.equal(config.states[trustedFeatureId("idle-auto-compactor")], false)
    assert.equal(config.states[trustedFeatureId("exec-guard")], true)
  })

  it("keeps the global flag across feature writes", () => {
    writeGlobalEnabled(false)
    writeFeatureEnabled(trustedFeatureId("first"), false)
    const config = readEssentialsConfig().config
    assert.equal(config.isEnabled, false)
    assert.deepEqual({ ...config.states }, { first: false })
  })

  it("migrates a legacy flat file on the first write", () => {
    writeRawState('{"idle-auto-compactor": false}')
    writeGlobalEnabled(false)
    const persisted = JSON.parse(
      readFileSync(resolveEssentialsStatePath(), "utf8"),
    )
    assert.equal(persisted.version, 1)
    assert.equal(persisted.enabled, false)
    assert.deepEqual(persisted.features, { "idle-auto-compactor": false })
  })

  it("clears a stored timeout without touching other settings", () => {
    const compactorId = trustedFeatureId("idle-auto-compactor")
    writeIdleTimeoutMs(compactorId, trustedTimeout(60_000))
    writeFeatureEnabled(compactorId, false)
    clearIdleTimeoutMs(compactorId)
    const config = readEssentialsConfig().config
    assert.deepEqual({ ...config.timeouts }, {})
    assert.equal(config.states[compactorId], false)
  })

  it("round-trips the idle timeout per feature", () => {
    const compactorId = trustedFeatureId("idle-auto-compactor")
    writeIdleTimeoutMs(compactorId, trustedTimeout(60_000))
    const config = readEssentialsConfig().config
    assert.equal(config.timeouts[compactorId], 60_000)
    assert.equal(
      resolveEffectiveIdleTimeoutMs(config, compactorId, trustedTimeout(999)),
      60_000,
    )
    assert.equal(
      resolveEffectiveIdleTimeoutMs(
        config,
        trustedFeatureId("other"),
        trustedTimeout(999),
      ),
      999,
    )
  })

  const unreadableContents: Array<[string, string]> = [
    ["corrupt text", "not json {{{"],
    ["an array", "[1, 2]"],
    ["a bare string", '"hello"'],
    ["an unknown version", '{"version": 2}'],
    ["a non-boolean flag", '{"version": 1, "enabled": "yes"}'],
  ]

  for (const [label, content] of unreadableContents) {
    it(`reports an error when the file holds ${label}`, () => {
      writeRawState(content)
      const configRead = readEssentialsConfig()
      assert.ok(configRead.error)
      assert.equal(configRead.config.isEnabled, true)
      assert.deepEqual({ ...configRead.config.states }, {})
    })
  }

  it("reports an error when the file is unreadable", () => {
    writeRawState('{"idle-auto-compactor": false}')
    chmodSync(resolveEssentialsStatePath(), 0o000)
    try {
      assert.ok(readEssentialsConfig().error)
    } finally {
      chmodSync(resolveEssentialsStatePath(), 0o644)
    }
  })

  it("ignores junk entries in a legacy flat file", () => {
    writeRawState('{"good": false, "stringy": "yes", "with space": true}')
    const config = readEssentialsConfig().config
    assert.deepEqual({ ...config.states }, { good: false })
  })

  it("leaves no temporary file behind after a write", () => {
    writeFeatureEnabled(trustedFeatureId("idle-auto-compactor"), false)
    const leftovers = readdirSync(path.dirname(resolveEssentialsStatePath()))
      .filter((name) => name.endsWith(".tmp"))
    assert.deepEqual(leftovers, [])
  })

  it("refuses to overwrite a corrupt state file", () => {
    writeRawState("not json {{{")
    assert.throws(() =>
      writeFeatureEnabled(trustedFeatureId("idle-auto-compactor"), true),
    )
    assert.throws(() => writeGlobalEnabled(false))
    assert.throws(() =>
      writeIdleTimeoutMs(trustedFeatureId("x"), trustedTimeout(1000)),
    )
    assert.equal(
      readFileSync(resolveEssentialsStatePath(), "utf8"),
      "not json {{{",
    )
  })

  it("reports an error when the state path is a directory", () => {
    mkdirSync(resolveEssentialsStatePath(), { recursive: true })
    assert.ok(readEssentialsConfig().error)
  })

  it("reports an error when the state file is oversized", () => {
    writeRawState(JSON.stringify({ padding: "x".repeat(70 * 1024) }))
    assert.ok(readEssentialsConfig().error)
  })

  it("reports an error when the state directory is writable by others", () => {
    mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
    chmodSync(path.dirname(resolveEssentialsStatePath()), 0o777)
    try {
      assert.ok(readEssentialsConfig().error)
    } finally {
      chmodSync(path.dirname(resolveEssentialsStatePath()), 0o700)
    }
  })
})
