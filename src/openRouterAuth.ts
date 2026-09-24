import { readFileSync } from "node:fs"
import path from "node:path"
import { resolveEssentialsStatePath } from "./state.ts"
import type { OpenRouterApiKey } from "./valueObject/openRouterApiKey.ts"
import { newOpenRouterApiKey } from "./valueObject/openRouterApiKey.ts"
import { isRecord } from "./valueObject/util.ts"

export type OpenRouterCredentialRead = {
  apiKey?: OpenRouterApiKey
  error?:
    | "OpenCodeAuthStoreInvalidJson"
    | "OpenCodeAuthStoreUnreadable"
    | "OpenRouterAuthEntryInvalid"
}

type AuthDocumentRead = {
  document?: unknown
  error?: OpenRouterCredentialRead["error"]
}

function resolveAuthFilePath(): string {
  return path.join(path.dirname(resolveEssentialsStatePath()), "auth.json")
}

function isMissingFileError(failure: unknown): boolean {
  if (!isRecord(failure)) return false
  return failure.code === "ENOENT"
}

function readAuthDocument(): AuthDocumentRead {
  let fileContents: string
  try {
    fileContents = readFileSync(resolveAuthFilePath(), "utf8")
  } catch (failure) {
    if (isMissingFileError(failure)) return {}
    return { error: "OpenCodeAuthStoreUnreadable" }
  }

  try {
    return { document: JSON.parse(fileContents) }
  } catch {
    return { error: "OpenCodeAuthStoreInvalidJson" }
  }
}

function resolveStoredOpenRouterApiKey(document: unknown): {
  apiKey?: OpenRouterApiKey
  error?: OpenRouterCredentialRead["error"]
} {
  if (!isRecord(document)) return { error: "OpenRouterAuthEntryInvalid" }
  const openRouterAuth = document.openrouter
  if (openRouterAuth === undefined) return {}
  if (!isRecord(openRouterAuth) || openRouterAuth.type !== "api") {
    return { error: "OpenRouterAuthEntryInvalid" }
  }
  const apiKey = newOpenRouterApiKey(openRouterAuth.key)
  if (!apiKey) return { error: "OpenRouterAuthEntryInvalid" }
  return { apiKey }
}

export function readOpenRouterApiKey(
  environmentValue: unknown,
): OpenRouterCredentialRead {
  const environmentApiKey = newOpenRouterApiKey(environmentValue)
  const authDocument = readAuthDocument()
  if (authDocument.error) {
    return { apiKey: environmentApiKey, error: authDocument.error }
  }
  if (authDocument.document === undefined) {
    return { apiKey: environmentApiKey }
  }
  const storedCredential = resolveStoredOpenRouterApiKey(authDocument.document)
  if (storedCredential.apiKey) return storedCredential
  return {
    apiKey: environmentApiKey,
    error: storedCredential.error,
  }
}
