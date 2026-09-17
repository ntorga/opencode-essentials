import type { FeatureId } from "./featureId.ts"
import { newFeatureId } from "./featureId.ts"
import type { FeatureStates } from "./featureStates.ts"
import { newFeatureStates } from "./featureStates.ts"
import type { IdleTimeoutMs } from "./idleTimeoutMs.ts"
import { newIdleTimeoutMs } from "./idleTimeoutMs.ts"
import type { ContextTokens } from "./contextTokens.ts"
import { newContextTokens } from "./contextTokens.ts"
import { isRecord } from "./util.ts"

export const ESSENTIALS_CONFIG_VERSION = 1

const RESERVED_DOCUMENT_KEYS = ["version", "enabled", "features", "settings"]
const IDLE_TIMEOUT_KEY = "idleTimeoutMs"
const CEILING_TOKENS_KEY = "ceilingTokens"

export type FeatureTimeouts = Partial<Record<FeatureId, IdleTimeoutMs>>

export type FeatureCeilings = Partial<Record<FeatureId, ContextTokens>>

export type EssentialsConfig = {
  isEnabled: boolean
  states: FeatureStates
  timeouts: FeatureTimeouts
  ceilings: FeatureCeilings
}

export function newDefaultEssentialsConfig(): EssentialsConfig {
  return {
    isEnabled: true,
    states: Object.create(null) as FeatureStates,
    timeouts: Object.create(null) as FeatureTimeouts,
    ceilings: Object.create(null) as FeatureCeilings,
  }
}

// A settings entry is one feature's whole tuning block, holding whichever
// tunables it uses. Half-trusting it — dropping a broken field silently —
// would revert the user's value to the default with no signal at 3am, so any
// present-but-uninterpretable field rejects the document. A feature with no
// stored tunables simply has no entry.
function newFeatureSettings(
  rawSettings: unknown,
): { timeouts: FeatureTimeouts; ceilings: FeatureCeilings } | undefined {
  const timeouts = Object.create(null) as FeatureTimeouts
  const ceilings = Object.create(null) as FeatureCeilings
  if (rawSettings === undefined) return { timeouts, ceilings }
  if (!isRecord(rawSettings)) return undefined
  for (const [rawKey, rawEntry] of Object.entries(rawSettings)) {
    const featureId = newFeatureId(rawKey)
    if (!featureId || !isRecord(rawEntry)) return undefined
    const rawTimeout = rawEntry[IDLE_TIMEOUT_KEY]
    const rawCeiling = rawEntry[CEILING_TOKENS_KEY]
    if (rawTimeout === undefined && rawCeiling === undefined) return undefined
    if (rawTimeout !== undefined) {
      const timeout = newIdleTimeoutMs(rawTimeout)
      if (timeout === undefined) return undefined
      timeouts[featureId] = timeout
    }
    if (rawCeiling !== undefined) {
      const ceiling = newContextTokens(rawCeiling)
      if (ceiling === undefined) return undefined
      ceilings[featureId] = ceiling
    }
  }
  return { timeouts, ceilings }
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
  const settings = newFeatureSettings(rawDocument["settings"])
  if (settings === undefined) return undefined
  config.timeouts = settings.timeouts
  config.ceilings = settings.ceilings
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
  const settings: Record<
    string,
    { idleTimeoutMs?: number; ceilingTokens?: number }
  > = {}
  for (const [featureId, timeout] of Object.entries(config.timeouts)) {
    if (timeout === undefined) continue
    settings[featureId] = { [IDLE_TIMEOUT_KEY]: timeout }
  }
  for (const [featureId, ceiling] of Object.entries(config.ceilings)) {
    if (ceiling === undefined) continue
    settings[featureId] = {
      ...settings[featureId],
      [CEILING_TOKENS_KEY]: ceiling,
    }
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
