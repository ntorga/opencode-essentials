import type { ValidatedString } from "./util.ts"
import { newValidated } from "./util.ts"

// Session ids reach URL path segments. The SDK encodes "/" but not ".",
// and Request normalizes "..", so only an anchored, bounded allowlist
// keeps a crafted id inside one segment. No type expresses what a URL path
// tolerates; the pattern absorbs that contract.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export type SessionId = ValidatedString<"SessionId">

export function newSessionId(rawValue: unknown): SessionId | undefined {
  return newValidated<"SessionId">(rawValue, SESSION_ID_PATTERN)
}
