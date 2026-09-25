// The reply the classifier sends when it auto-allows a request. `always` lets
// OpenCode save a rule so matching requests stop reaching the classifier;
// `once` answers only this request and asks again next time. It never carries
// `reject`: this value is chosen only after Jev already scored the request
// safe.
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
