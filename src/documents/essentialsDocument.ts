import type { ContextTokens } from "../valueObject/contextTokens.ts"
import { newContextTokens } from "../valueObject/contextTokens.ts"
import type { FeatureId } from "../valueObject/featureId.ts"
import { newFeatureId } from "../valueObject/featureId.ts"
import type { FeatureStates } from "../valueObject/featureStates.ts"
import { newFeatureStates } from "../valueObject/featureStates.ts"
import type { IdleTimeoutMs } from "../valueObject/idleTimeoutMs.ts"
import { newIdleTimeoutMs } from "../valueObject/idleTimeoutMs.ts"
import type { OpenRouterModelId } from "../valueObject/openRouterModelId.ts"
import { newOpenRouterModelId } from "../valueObject/openRouterModelId.ts"
import { isRecord } from "../valueObject/util.ts"
import type { ParsedDocument } from "./util.ts"
import { newParsedDocument } from "./util.ts"

export const ESSENTIALS_CONFIG_VERSION = 1

const RESERVED_DOCUMENT_KEYS = ["version", "enabled", "features", "settings"]
const IDLE_TIMEOUT_KEY = "idleTimeoutMs"
const CEILING_TOKENS_KEY = "ceilingTokens"
const CLASSIFIER_MODEL_KEY = "model"

export type FeatureTimeouts = Partial<Record<FeatureId, IdleTimeoutMs>>

export type FeatureCeilings = Partial<Record<FeatureId, ContextTokens>>

export type FeatureModels = Partial<Record<FeatureId, OpenRouterModelId>>

type EssentialsFields = {
  isEnabled: boolean
  states: FeatureStates
  timeouts: FeatureTimeouts
  ceilings: FeatureCeilings
  models: FeatureModels
}

export type EssentialsConfig = ParsedDocument<EssentialsFields, "essentials">

export function newDefaultEssentialsConfig(): EssentialsConfig {
  return newParsedDocument<EssentialsFields, "essentials">({
    isEnabled: true,
    states: Object.create(null) as FeatureStates,
    timeouts: Object.create(null) as FeatureTimeouts,
    ceilings: Object.create(null) as FeatureCeilings,
    models: Object.create(null) as FeatureModels,
  })
}

// A settings entry is one feature's whole tuning block, holding whichever
// tunables it uses. Half-trusting it — dropping a broken field silently —
// would revert the user's value to the default with no signal at 3am, so any
// present-but-uninterpretable field rejects the document. A feature with no
// stored tunables simply has no entry.
function newFeatureSettings(rawSettings: unknown):
  | {
      timeouts: FeatureTimeouts
      ceilings: FeatureCeilings
      models: FeatureModels
    }
  | undefined {
  const timeouts = Object.create(null) as FeatureTimeouts
  const ceilings = Object.create(null) as FeatureCeilings
  const models = Object.create(null) as FeatureModels
  if (rawSettings === undefined) return { timeouts, ceilings, models }
  if (!isRecord(rawSettings)) return undefined
  for (const [rawKey, rawEntry] of Object.entries(rawSettings)) {
    const featureId = newFeatureId(rawKey)
    if (!featureId || !isRecord(rawEntry)) return undefined
    const rawTimeout = rawEntry[IDLE_TIMEOUT_KEY]
    const rawCeiling = rawEntry[CEILING_TOKENS_KEY]
    const rawModel = rawEntry[CLASSIFIER_MODEL_KEY]
    if (
      rawTimeout === undefined &&
      rawCeiling === undefined &&
      rawModel === undefined
    ) {
      return undefined
    }
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
    if (rawModel !== undefined) {
      const model = newOpenRouterModelId(rawModel)
      if (model === undefined) return undefined
      models[featureId] = model
    }
  }
  return { timeouts, ceilings, models }
}

function newVersionedConfig(
  rawDocument: Record<string, unknown>,
): EssentialsConfig | undefined {
  if (rawDocument.version !== ESSENTIALS_CONFIG_VERSION) return undefined
  const config = newDefaultEssentialsConfig()
  if (rawDocument.enabled !== undefined) {
    if (typeof rawDocument.enabled !== "boolean") return undefined
    config.isEnabled = rawDocument.enabled
  }
  const rawFeatures = rawDocument.features
  const states = newFeatureStates(rawFeatures === undefined ? {} : rawFeatures)
  if (states === undefined) return undefined
  config.states = states
  const settings = newFeatureSettings(rawDocument.settings)
  if (settings === undefined) return undefined
  config.timeouts = settings.timeouts
  config.ceilings = settings.ceilings
  config.models = settings.models
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

export function parseEssentialsDocument(
  rawDocument: unknown,
): EssentialsConfig | undefined {
  if (!isRecord(rawDocument)) return undefined
  if (!("version" in rawDocument)) return newLegacyConfig(rawDocument)
  return newVersionedConfig(rawDocument)
}

export function serializeEssentialsDocument(config: EssentialsConfig): string {
  const settings: Record<
    string,
    {
      idleTimeoutMs?: number
      ceilingTokens?: number
      model?: OpenRouterModelId
    }
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
  for (const [featureId, model] of Object.entries(config.models)) {
    if (model === undefined) continue
    settings[featureId] = {
      ...settings[featureId],
      [CLASSIFIER_MODEL_KEY]: model,
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
