import type { ValidatedString } from "./util.ts"
import { MODEL_TOKEN_PATTERN, newValidated } from "./util.ts"

export type ProviderId = ValidatedString<"ProviderId">

export function newProviderId(rawValue: unknown): ProviderId | undefined {
  return newValidated<"ProviderId">(rawValue, MODEL_TOKEN_PATTERN)
}
