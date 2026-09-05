import type { FeatureId } from "./featureId.ts"
import { newFeatureId } from "./featureId.ts"
import type { FeatureStates } from "./featureStates.ts"
import { newFeatureStates } from "./featureStates.ts"
import type { IdleTimeoutMs } from "./idleTimeoutMs.ts"
import { newIdleTimeoutMs } from "./idleTimeoutMs.ts"
import { isRecord } from "./util.ts"

export const ESSENTIALS_CONFIG_VERSION = 1

const RESERVED_DOCUMENT_KEYS = ["version", "enabled", "features", "settings"]

export type FeatureTimeouts = Partial<Record<FeatureId, IdleTimeoutMs>>

export type EssentialsConfig = {
  isEnabled: boolean
  states: FeatureStates
  timeouts: FeatureTimeouts
}

export function newDefaultEssentialsConfig(): EssentialsConfig {
  return {
    isEnabled: true,
    states: Object.create(null) as FeatureStates,
    timeouts: Object.create(null) as FeatureTimeouts,
  }
}

// A settings entry is one feature's whole tuning block. Half-trusting it —
// dropping a broken entry silently — would revert the user's timeout to the
// default with no signal at 3am, so any uninterpretable entry rejects the
// document.
function newFeatureTimeouts(
  rawSettings: unknown,
): FeatureTimeouts | undefined {
  if (rawSettings === undefined) return Object.create(null)
  if (!isRecord(rawSettings)) return undefined
  const timeouts = Object.create(null) as FeatureTimeouts
  for (const [rawKey, rawEntry] of Object.entries(rawSettings)) {
    const featureId = newFeatureId(rawKey)
    if (!featureId || !isRecord(rawEntry)) return undefined
    const timeout = newIdleTimeoutMs(rawEntry["idleTimeoutMs"])
    if (timeout === undefined) return undefined
    timeouts[featureId] = timeout
  }
  return timeouts
}

function newVersionedConfig(
  rawDocument: Record<string, unknown>,
): EssentialsConfig | undefined {
  if (rawDocument["version"] !== ESSENTIALS_CONFIG_VERSION) return undefined
  const config = newDefaultEssentialsConfig()
  if (rawDocument["enabled"] !== undefined) {
    if (typeof rawDocument["enabled"] !== "boolean") return undefined
    config.isEnabled = rawDocument["enabled"]
  }
  const rawFeatures = rawDocument["features"]
  const states = newFeatureStates(
    rawFeatures === undefined ? {} : rawFeatures,
  )
  if (states === undefined) return undefined
  config.states = states
  const timeouts = newFeatureTimeouts(rawDocument["settings"])
  if (timeouts === undefined) return undefined
  config.timeouts = timeouts
  return config
}

// The pre-version shape was a flat feature-id-to-boolean map. Reserved
// document keys in such a map mean a misspelled version or a hand-edit
// gone wrong; guessing either way could re-enable features the user
// switched off, so the document is refused instead.
function newLegacyConfig(rawDocument: unknown): EssentialsConfig | undefined {
  const states = newFeatureStates(rawDocument)
  if (states === undefined) return undefined
  const legacyKeys = Object.keys(rawDocument as Record<string, unknown>)
  if (legacyKeys.some((key) => RESERVED_DOCUMENT_KEYS.includes(key))) {
    return undefined
  }
  return { ...newDefaultEssentialsConfig(), states }
}

export function parseEssentialsConfig(
  rawDocument: unknown,
): EssentialsConfig | undefined {
  if (!isRecord(rawDocument)) return undefined
  if (!("version" in rawDocument)) return newLegacyConfig(rawDocument)
  return newVersionedConfig(rawDocument)
}

export function serializeEssentialsConfig(config: EssentialsConfig): string {
  const settings: Record<string, { idleTimeoutMs: number }> = {}
  for (const [featureId, timeout] of Object.entries(config.timeouts)) {
    if (timeout === undefined) continue
    settings[featureId] = { idleTimeoutMs: timeout }
  }
  return JSON.stringify(
    {
      version: ESSENTIALS_CONFIG_VERSION,
      enabled: config.isEnabled,
      features: { ...config.states },
      settings,
    },
    null,
    2,
  )
}
