import type { PermissionName } from "./permissionName.ts"
import { newPermissionName } from "./permissionName.ts"
import type { PermissionRequestId } from "./permissionRequestId.ts"
import { newPermissionRequestId } from "./permissionRequestId.ts"
import type { SessionId } from "./sessionId.ts"
import { newSessionId } from "./sessionId.ts"
import { isRecord } from "./util.ts"

export type PermissionRequest = {
  id: PermissionRequestId
  sessionID: SessionId
  permission: PermissionName
  patterns: string[]
}

export function newPermissionRequest(
  rawValue: unknown,
): PermissionRequest | undefined {
  if (!isRecord(rawValue)) return undefined
  const id = newPermissionRequestId(rawValue.id)
  if (!id) return undefined
  const sessionID = newSessionId(rawValue.sessionID)
  if (!sessionID) return undefined
  const permission = newPermissionName(rawValue.permission)
  if (!permission) return undefined
  if (!Array.isArray(rawValue.patterns)) return undefined
  if (!rawValue.patterns.every((pattern) => typeof pattern === "string")) {
    return undefined
  }
  return {
    id,
    sessionID,
    permission,
    patterns: rawValue.patterns,
  }
}
