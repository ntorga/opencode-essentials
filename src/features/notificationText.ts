const END_OF_OPTIONS = "--"

export function escapeNotificationMarkup(notificationText: string): string {
  return notificationText
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

export function buildPermissionNotificationArguments(
  notificationText: string,
): string[] {
  return [
    "--app-name=OpenCode",
    "--wait",
    "--expire-time=0",
    "--action=allow=Allow once",
    "--action=always=Allow always",
    END_OF_OPTIONS,
    "OpenCode needs permission",
    escapeNotificationMarkup(notificationText),
  ]
}
