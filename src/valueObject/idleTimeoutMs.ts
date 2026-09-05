import type { ValidatedNumber } from "./util.ts"

// Positive finite durations only. The Node timer ceiling (2^31-1 ms) is a
// policy decision for resolveIdleTimeoutMs, which clamps rather than
// rejects; this parse just refuses nonsense.
export type IdleTimeoutMs = ValidatedNumber<"IdleTimeoutMs">

export function newIdleTimeoutMs(
  rawValue: unknown,
): IdleTimeoutMs | undefined {
  if (typeof rawValue !== "number") return undefined
  if (!Number.isFinite(rawValue) || rawValue <= 0) return undefined
  return rawValue as IdleTimeoutMs
}
