import type { ValidatedString } from "./util.ts"
import { newValidated } from "./util.ts"

export type OpenRouterModelId = ValidatedString<"OpenRouterModelId">

const OPENROUTER_MODEL_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}$/

export function newOpenRouterModelId(
  rawValue: unknown,
): OpenRouterModelId | undefined {
  return newValidated<"OpenRouterModelId">(
    rawValue,
    OPENROUTER_MODEL_ID_PATTERN,
  )
}
