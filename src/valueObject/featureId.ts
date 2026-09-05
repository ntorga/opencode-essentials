import type { ValidatedString } from "./util.ts"
import { newValidated } from "./util.ts"

// Feature ids are used as JSON keys in the toggle file and as config option
// buckets; they never reach a URL. Dots are legitimate here, so the pattern
// is an identifier shape, not a path-segment shape.
const FEATURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

export type FeatureId = ValidatedString<"FeatureId">

export function newFeatureId(rawValue: unknown): FeatureId | undefined {
  return newValidated<"FeatureId">(rawValue, FEATURE_ID_PATTERN)
}
