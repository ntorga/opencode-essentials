import type { FeatureId } from "./featureId.ts"
import { newFeatureId } from "./featureId.ts"
import { isRecord } from "./util.ts"

// Keys come from the toggle file, so a foreign key must not survive into
// the states map. The null prototype keeps an own "__proto__" key inert.
export type FeatureStates = Partial<Record<FeatureId, boolean>>

export function newFeatureStates(
  rawStates: unknown,
): FeatureStates | undefined {
  if (!isRecord(rawStates)) return undefined
  const states = Object.create(null) as FeatureStates
  for (const [rawKey, rawValue] of Object.entries(rawStates)) {
    const featureId = newFeatureId(rawKey)
    if (featureId && typeof rawValue === "boolean") states[featureId] = rawValue
  }
  return states
}
