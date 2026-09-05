import type { ValidatedString } from "./util.ts"
import { MODEL_TOKEN_PATTERN, newValidated } from "./util.ts"

export type ModelId = ValidatedString<"ModelId">

export function newModelId(rawValue: unknown): ModelId | undefined {
  return newValidated<"ModelId">(rawValue, MODEL_TOKEN_PATTERN)
}
