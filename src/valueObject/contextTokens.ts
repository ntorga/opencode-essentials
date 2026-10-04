import type { ValidatedNumber } from "./util.ts"

// A token count used as a compaction ceiling. The dialog presets stop at
// 1M; the type ceiling sits higher, so a hand-edited state file still
// loads.
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
