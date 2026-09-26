import type { PermissionName } from "../valueObject/permissionName.ts"

const MAX_TRACKED_SESSIONS = 64
const MAX_APPROVALS_PER_SESSION = 256

type MemoryEntry = {
  sessionID: string
  permission: PermissionName
  patterns: readonly string[]
}

// A remembered approval is a whole request, not a bare path: the same path can
// be safe to edit but not to read, so the permission name is part of the key.
// The pattern list is JSON-encoded because patterns are unvalidated strings —
// a raw newline join would let ["a","b"] and ["a\nb"] collide and authorize the
// wrong request.
function memoryKey(entry: MemoryEntry): string {
  return `${entry.permission}\n${JSON.stringify(entry.patterns)}`
}

// The classifier's own short-term memory. OpenCode cannot remember a single
// file edit: its `always` reply stores the pattern the tool declares, and the
// edit tool declares `*`. So the assistant answers a safe edit with `once` and
// keeps the approved requests itself, letting a repeat in the same session skip
// Jev. Entries live for the session and are bounded, so a session that ends
// without a delete signal cannot grow the map without limit.
export type PermissionMemory = {
  recall: (entry: MemoryEntry) => boolean
  remember: (entry: MemoryEntry) => void
  forgetSession: (sessionID: string) => void
  trackedSessionCount: () => number
}

export function newPermissionMemory(): PermissionMemory {
  const approvalsBySession = new Map<string, Set<string>>()

  function ensureSessionApprovals(sessionID: string): Set<string> {
    const existing = approvalsBySession.get(sessionID)
    if (existing !== undefined) return existing
    const created = new Set<string>()
    approvalsBySession.set(sessionID, created)
    while (approvalsBySession.size > MAX_TRACKED_SESSIONS) {
      const oldest = approvalsBySession.keys().next().value
      if (oldest === undefined) break
      approvalsBySession.delete(oldest)
    }
    return created
  }

  return {
    recall: (entry) =>
      approvalsBySession.get(entry.sessionID)?.has(memoryKey(entry)) === true,
    remember: (entry) => {
      const approvals = ensureSessionApprovals(entry.sessionID)
      approvals.add(memoryKey(entry))
      while (approvals.size > MAX_APPROVALS_PER_SESSION) {
        const oldest = approvals.values().next().value
        if (oldest === undefined) break
        approvals.delete(oldest)
      }
    },
    forgetSession: (sessionID) => {
      approvalsBySession.delete(sessionID)
    },
    trackedSessionCount: () => approvalsBySession.size,
  }
}
