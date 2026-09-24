import type { ValidatedNumber } from "./util.ts"

export type TokenCount = ValidatedNumber<"TokenCount">

export function newTokenCount(rawValue: unknown): TokenCount | undefined {
  if (typeof rawValue !== "number") return undefined
  if (!Number.isSafeInteger(rawValue) || rawValue < 0) return undefined
  return rawValue as TokenCount
}
