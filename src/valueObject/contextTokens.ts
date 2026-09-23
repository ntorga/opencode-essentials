import type { ValidatedNumber } from "./util.ts"

// A token count used as a compaction ceiling. The presets in the dialog stop
// at 1M; the ceiling of this type leaves headroom for a hand-edited state
// file so such an edit is stored faithfully instead of rejected or clamped.
export type ContextTokens = ValidatedNumber<"ContextTokens">

export const MAX_TOKEN_CEILING = 2_000_000 as ContextTokens

export const DEFAULT_TOKEN_CEILING = 384_000 as ContextTokens

export const TOKEN_CEILING_PRESETS: readonly ContextTokens[] = [
  128_000, 256_000, 384_000, 512_000, 768_000, 1_000_000,
] as ContextTokens[]

export function newContextTokens(rawValue: unknown): ContextTokens | undefined {
  if (typeof rawValue !== "number") return undefined
  if (!Number.isSafeInteger(rawValue) || rawValue <= 0) return undefined
  if (rawValue > MAX_TOKEN_CEILING) return undefined
  return rawValue as ContextTokens
}
