import type { PermissionName } from "../valueObject/permissionName.ts"
import type { PermissionReplyMode } from "../valueObject/permissionReplyMode.ts"

// A remembered approval is kept in the classifier's own per-session memory
// (see features/permissionMemory.ts), never as an OpenCode rule: an OpenCode
// `always` reply stores the pattern the tool declares, and the edit tool
// declares `*`, so it would open every edit. The assistant answers `once` and
// remembers the single path instead.
//
// Only file edits qualify. A Bash approval must not be replayed automatically:
// the safe command the classifier judged once is not a promise that a later
// request carrying the same text is safe. Everything else reaches Jev again.
const AUTO_ALLOW_REMEMBER_PERMISSIONS: ReadonlySet<string> = new Set(["edit"])

export function shouldRememberApproval(
  permission: PermissionName,
  preferredMode: PermissionReplyMode,
): boolean {
  if (preferredMode !== "always") return false
  return AUTO_ALLOW_REMEMBER_PERMISSIONS.has(permission)
}
