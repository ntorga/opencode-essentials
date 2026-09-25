import type { PermissionName } from "../valueObject/permissionName.ts"
import type { PermissionReplyMode } from "../valueObject/permissionReplyMode.ts"

// OpenCode saves an `always` reply under the pattern the requesting tool
// declares, not under the exact thing Jev judged:
// - edit (edit, write, apply_patch): the pattern is `*`, so a remembered
//   approval covers workspace file edits only, and git can undo them.
// - bash: the pattern is the command prefix plus a wildcard — `rm *` for any
//   `rm`. One approved `rm file` would silently allow a later `rm -rf /` that
//   Jev never saw.
// - external_directory: the pattern widens the one approved file to every
//   path in its directory, outside the workspace where credentials live.
// Only the first class is safe to remember; the rest answer `once`.
const AUTO_ALLOW_REMEMBER_PERMISSIONS: ReadonlySet<string> = new Set(["edit"])

export function newAutoAllowReply(
  permission: PermissionName,
  preferredMode: PermissionReplyMode,
): PermissionReplyMode {
  if (preferredMode !== "always") return "once"
  return AUTO_ALLOW_REMEMBER_PERMISSIONS.has(permission) ? "always" : "once"
}
