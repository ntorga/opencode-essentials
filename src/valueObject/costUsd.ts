import type { ValidatedNumber } from "./util.ts"

export type CostUsd = ValidatedNumber<"CostUsd">

export function newCostUsd(rawValue: unknown): CostUsd | undefined {
  if (typeof rawValue !== "number") return undefined
  if (!Number.isFinite(rawValue) || rawValue < 0) return undefined
  return rawValue as CostUsd
}
