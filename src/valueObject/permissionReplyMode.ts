// The user's preference for what the classifier does with a safe verdict.
// The classifier always replies `once` to OpenCode; this value only decides
// whether the guard remembers the path. It never carries `reject`: it
// applies only after Jev scored the request safe.
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
