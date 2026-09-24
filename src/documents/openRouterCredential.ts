import type { OpenRouterApiKey } from "../valueObject/openRouterApiKey.ts"
import { newOpenRouterApiKey } from "../valueObject/openRouterApiKey.ts"
import { isRecord } from "../valueObject/util.ts"

// OpenCode's shared auth store keeps one entry per provider. This document
// owns only the OpenRouter entry: its shape decides whether a stored
// credential can be trusted, and nothing else reads the store.
export type OpenRouterCredentialResolution =
  | { status: "absent" }
  | { status: "valid"; apiKey: OpenRouterApiKey }
  | { status: "invalid" }

export function parseOpenRouterCredential(
  rawDocument: unknown,
): OpenRouterCredentialResolution {
  if (!isRecord(rawDocument)) return { status: "invalid" }
  const entry = rawDocument.openrouter
  if (entry === undefined) return { status: "absent" }
  if (!isRecord(entry) || entry.type !== "api") return { status: "invalid" }
  const apiKey = newOpenRouterApiKey(entry.key)
  if (apiKey === undefined) return { status: "invalid" }
  return { status: "valid", apiKey }
}
