import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { newContextTokens } from "./contextTokens.ts"
import {
  ESSENTIALS_CONFIG_VERSION,
  newDefaultEssentialsConfig,
  parseEssentialsConfig,
  serializeEssentialsConfig,
} from "./essentialsConfig.ts"
import type { FeatureId } from "./featureId.ts"
import { newIdleTimeoutMs } from "./idleTimeoutMs.ts"

const compactorId = "idle-auto-compactor" as FeatureId
const ceilingId = "token-ceiling-compactor" as FeatureId

function copyStates(config: ReturnType<typeof parseEssentialsConfig>) {
  if (config === undefined) return undefined
  return { ...config.states }
}

describe("parseEssentialsConfig", () => {
  it("rejects non-objects", () => {
    for (const rejected of [null, undefined, 7, "x", []]) {
      assert.equal(parseEssentialsConfig(rejected), undefined)
    }
  })

  it("migrates the legacy flat boolean map", () => {
    const config = parseEssentialsConfig({ "idle-auto-compactor": false })
    assert.equal(config?.isEnabled, true)
    assert.deepEqual(copyStates(config), { "idle-auto-compactor": false })
    assert.deepEqual({ ...config?.timeouts }, {})
  })

  it("ignores non-boolean entries in a legacy map", () => {
    const config = parseEssentialsConfig({
      "idle-auto-compactor": true,
      junk: "yes",
    })
    assert.deepEqual(copyStates(config), { "idle-auto-compactor": true })
  })

  it("reads a full versioned document", () => {
    const config = parseEssentialsConfig({
      version: ESSENTIALS_CONFIG_VERSION,
      enabled: false,
      features: { "idle-auto-compactor": true },
      settings: { "idle-auto-compactor": { idleTimeoutMs: 60000 } },
    })
    assert.equal(config?.isEnabled, false)
    assert.deepEqual(copyStates(config), { "idle-auto-compactor": true })
    assert.deepEqual({ ...config?.timeouts }, { "idle-auto-compactor": 60000 })
  })

  it("reads a settings entry that stores only a token ceiling", () => {
    const config = parseEssentialsConfig({
      version: ESSENTIALS_CONFIG_VERSION,
      settings: { [ceilingId]: { ceilingTokens: 128000 } },
    })
    assert.deepEqual({ ...config?.ceilings }, { [ceilingId]: 128000 })
    assert.deepEqual({ ...config?.timeouts }, {})
  })

  it("reads a settings entry that stores both tunables", () => {
    const config = parseEssentialsConfig({
      version: ESSENTIALS_CONFIG_VERSION,
      settings: {
        [ceilingId]: { idleTimeoutMs: 60000, ceilingTokens: 512000 },
      },
    })
    assert.deepEqual({ ...config?.timeouts }, { [ceilingId]: 60000 })
    assert.deepEqual({ ...config?.ceilings }, { [ceilingId]: 512000 })
  })

  it("defaults enabled, features, and settings when absent", () => {
    const config = parseEssentialsConfig({ version: ESSENTIALS_CONFIG_VERSION })
    assert.deepEqual(config, newDefaultEssentialsConfig())
  })

  it("rejects an unknown version", () => {
    assert.equal(parseEssentialsConfig({ version: 2 }), undefined)
    assert.equal(parseEssentialsConfig({ version: "1" }), undefined)
  })

  it("rejects a non-boolean enabled flag", () => {
    assert.equal(
      parseEssentialsConfig({ version: ESSENTIALS_CONFIG_VERSION, enabled: 1 }),
      undefined,
    )
  })

  it("rejects a malformed features or settings block", () => {
    for (const block of ["nope", null, 5]) {
      assert.equal(
        parseEssentialsConfig({
          version: ESSENTIALS_CONFIG_VERSION,
          features: block,
        }),
        undefined,
        `features: ${JSON.stringify(block)}`,
      )
      assert.equal(
        parseEssentialsConfig({
          version: ESSENTIALS_CONFIG_VERSION,
          settings: block,
        }),
        undefined,
        `settings: ${JSON.stringify(block)}`,
      )
    }
  })

  for (const broken of [
    { "idle-auto-compactor": { idleTimeoutMs: -5 } },
    { "idle-auto-compactor": {} },
    { "": { idleTimeoutMs: 5 } },
    { "idle-auto-compactor": 5 },
    { [ceilingId]: { ceilingTokens: 0 } },
    { [ceilingId]: { ceilingTokens: 1.5 } },
    { [ceilingId]: { ceilingTokens: 2000001 } },
    { [ceilingId]: { ceilingTokens: "384000" } },
  ]) {
    it(`rejects the document over settings ${JSON.stringify(broken)}`, () => {
      assert.equal(
        parseEssentialsConfig({
          version: ESSENTIALS_CONFIG_VERSION,
          settings: broken,
        }),
        undefined,
      )
    })
  }

  it("refuses a legacy-shaped document holding reserved keys", () => {
    const smuggled = {
      verzion: 1,
      enabled: false,
      features: { "idle-auto-compactor": false },
    }
    assert.equal(parseEssentialsConfig(smuggled), undefined)
    assert.equal(parseEssentialsConfig({ enabled: false }), undefined)
  })
})

describe("serializeEssentialsConfig", () => {
  it("round-trips a config through JSON", () => {
    const config = newDefaultEssentialsConfig()
    config.isEnabled = false
    config.states[compactorId] = true
    config.timeouts[compactorId] = newIdleTimeoutMs(1234)
    const reparsed = parseEssentialsConfig(
      JSON.parse(serializeEssentialsConfig(config)),
    )
    assert.deepEqual(reparsed, config)
  })

  it("round-trips ceilings alongside timeouts", () => {
    const config = newDefaultEssentialsConfig()
    config.timeouts[compactorId] = newIdleTimeoutMs(900000)
    config.ceilings[ceilingId] = newContextTokens(1000000)
    config.ceilings[compactorId] = newContextTokens(256000)
    const serialized = JSON.parse(serializeEssentialsConfig(config))
    assert.deepEqual(serialized.settings, {
      "idle-auto-compactor": { idleTimeoutMs: 900000, ceilingTokens: 256000 },
      "token-ceiling-compactor": { ceilingTokens: 1000000 },
    })
    assert.deepEqual(parseEssentialsConfig(serialized), config)
  })

  it("writes an empty settings block when no timeouts exist", () => {
    const serialized = JSON.parse(
      serializeEssentialsConfig(newDefaultEssentialsConfig()),
    )
    assert.deepEqual(serialized.settings, {})
    assert.equal(serialized.version, ESSENTIALS_CONFIG_VERSION)
    assert.equal(serialized.enabled, true)
  })
})
