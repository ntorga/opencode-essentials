import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

export type StatusBarTone = "info" | "good" | "muted" | "warning" | "error"

export function resolveStatusBarTextColor(
  api: TuiPluginApi,
  tone: StatusBarTone,
) {
  if (tone === "info") return api.theme.current.info
  if (tone === "good") return api.theme.current.success
  if (tone === "error") return api.theme.current.error
  if (tone === "warning") return api.theme.current.warning
  return api.theme.current.textMuted
}
