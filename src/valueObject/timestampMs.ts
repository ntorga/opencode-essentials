import type { ValidatedNumber } from "./util.ts"

// Wall-clock epoch milliseconds read out of synced host state. The lower
// bound is the year 2001: a genuine epoch-ms timestamp can never sit under
// it, while a seconds-based epoch or a leaked monotonic counter would make
// the idle clock show decades.
export type TimestampMs = ValidatedNumber<"TimestampMs">

const MIN_PLAUSIBLE_EPOCH_MS = 978_307_200_000

export function newTimestampMs(rawValue: unknown): TimestampMs | undefined {
  if (typeof rawValue !== "number") return undefined
  if (!Number.isFinite(rawValue)) return undefined
  if (rawValue < MIN_PLAUSIBLE_EPOCH_MS) return undefined
  return rawValue as TimestampMs
}
