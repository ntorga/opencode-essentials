import type { PluginInput } from "@opencode-ai/plugin"
import { writeLog } from "../log.ts"

// A rejected host id is a protocol violation, not routine noise. The key is
// the feature's own searchable name; the payload shape is shared so a host
// format drift surfaces with identical evidence in every feature's log.
export async function logRejectedHostId(
  client: PluginInput["client"],
  logKey: string,
  eventLabel: string,
  rejectedValue: unknown,
) {
  await writeLog(client, "warn", logKey, {
    event: eventLabel,
    rejectedValue: String(rejectedValue),
  })
}
