// The user's preference for what the classifier does with a safe verdict.
// `always` remembers the approved edit for the session (see
// features/permissionMemory.ts); `once` answers the request and judges the next
// one again. The reply the classifier sends to OpenCode is always `once`; this
// value only decides whether the path is remembered. It never carries `reject`:
// this preference applies only after Jev scored the request safe.
export type PermissionReplyMode = "once" | "always"

export const DEFAULT_AUTO_ALLOW_REPLY: PermissionReplyMode = "always"

const PERMISSION_REPLY_MODES: readonly PermissionReplyMode[] = [
  "once",
  "always",
]

export function newPermissionReplyMode(
  rawValue: unknown,
): PermissionReplyMode | undefined {
  return PERMISSION_REPLY_MODES.find((mode) => mode === rawValue)
}
