import type { PermissionAuditActor } from "./permissionAudit.ts"

export type PermissionHandlingCounts = {
  autoHandled: number
  total: number
}

const counts: PermissionHandlingCounts = { autoHandled: 0, total: 0 }

// `classifier` and `cache` are the two shapes of a Jev answer: a fresh
// verdict, and a replay from the session memory. The human and the
// doom-loop rule answer without Jev, so they count in the total but not in
// the auto share. The tally lives for the life of the TUI process — it
// reads as "since you opened this terminal", not project history; the audit
// log carries the long view.
export function countPermissionDecision(actor: PermissionAuditActor): void {
  counts.total += 1
  if (actor === "classifier" || actor === "cache") counts.autoHandled += 1
}

export function readPermissionHandlingCounts(): PermissionHandlingCounts {
  return { autoHandled: counts.autoHandled, total: counts.total }
}
