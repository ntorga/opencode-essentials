import { readFileSync } from "node:fs"
import path from "node:path"
import { parseOpenRouterCredential } from "./documents/openRouterCredential.ts"
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
  const storedCredential = parseOpenRouterCredential(authDocument.document)
  if (storedCredential.status === "valid") {
    return { apiKey: storedCredential.apiKey }
  }
  if (storedCredential.status === "absent") {
    return { apiKey: environmentApiKey }
  }
  return { apiKey: environmentApiKey, error: "OpenRouterAuthEntryInvalid" }
}
