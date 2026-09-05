import type { ValidatedNumber } from "./util.ts"

// Positive finite durations only. Node's timer ceiling is policy for the
// consumers: resolveIdleTimeoutMs clamps the plugin option and
// clampToTimerCeiling caps the state-file value, both to MAX_TIMER_DELAY_MS.
export type IdleTimeoutMs = ValidatedNumber<"IdleTimeoutMs">

export const MAX_TIMER_DELAY_MS = (2 ** 31 - 1) as IdleTimeoutMs

export const DEFAULT_IDLE_TIMEOUT_MS = (30 * 60 * 1000) as IdleTimeoutMs

// The custom-minutes prompt bounds input here so no consumer ever stores a
// value that needs clamping. 2^31-1 ms is about 24.8 days.
export const MAX_TIMEOUT_MINUTES = Math.floor(MAX_TIMER_DELAY_MS / 60_000)

export function newIdleTimeoutMs(
  rawValue: unknown,
): IdleTimeoutMs | undefined {
  if (typeof rawValue !== "number") return undefined
  if (!Number.isFinite(rawValue) || rawValue <= 0) return undefined
  return rawValue as IdleTimeoutMs
}
