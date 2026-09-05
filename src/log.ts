import type { PluginInput } from "@opencode-ai/plugin"

export async function writeLog(
  client: PluginInput["client"],
  level: "debug" | "info" | "warn",
  message: string,
  extra: Record<string, unknown>,
) {
  try {
    await client.app.log({
      body: {
        service: "opencode-essentials",
        level,
        message,
        extra,
      },
    })
  } catch {
    // Callers include the compaction failure path; rethrowing would surface
    // as an unhandled rejection inside a setTimeout callback, so the guard
    // is the structure that absorbs the contract.
  }
}
