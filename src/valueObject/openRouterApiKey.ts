import type { ValidatedString } from "./util.ts"

export type OpenRouterApiKey = ValidatedString<"OpenRouterApiKey">

export function newOpenRouterApiKey(
  rawValue: unknown,
): OpenRouterApiKey | undefined {
  if (typeof rawValue !== "string") return undefined
  const apiKey = rawValue.trim()
  if (apiKey.length === 0 || apiKey.length > 512) return undefined
  if (/\p{Cc}/u.test(apiKey)) return undefined
  return apiKey as OpenRouterApiKey
}
