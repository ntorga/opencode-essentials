import type { PluginInput } from "@opencode-ai/plugin"

const MAX_LOG_VALUE_CHARS = 500

// Log values can carry raw external text — a parse error quotes the
// attacker-controlled bytes it choked on. Stripping non-printable
// characters stops forged log lines and terminal escapes. No type absorbs
// that contract; the sink sanitizes.
function printableText(value: unknown): string {
  const flattened = String(value)
  const stripped = flattened.replace(/[\u0000-\u001F\u007F]/g, " ")
  return stripped.slice(0, MAX_LOG_VALUE_CHARS)
}

function printableExtras(extra: Record<string, unknown>) {
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(extra)) {
    sanitized[key] = printableText(value)
  }
  return sanitized
}

export async function writeLog(
  client: PluginInput["client"],
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra: Record<string, unknown>,
) {
  try {
    await client.app.log({
      body: {
        service: "opencode-essentials",
        level,
        message: printableText(message),
        extra: printableExtras(extra),
      },
    })
  } catch {
    // Callers include the compaction failure path; rethrowing would surface
    // as an unhandled rejection inside a setTimeout callback, so the guard
    // is the structure that absorbs the contract.
  }
}
