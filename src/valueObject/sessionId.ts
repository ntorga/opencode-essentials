import type { ValidatedString } from "./util.ts"
import { newValidated } from "./util.ts"

// Session ids reach URL path segments. The SDK encodes "/" but not ".",
// and Request normalizes "..". Only an anchored, bounded allowlist keeps a
// crafted id inside one segment; the pattern absorbs a contract no type can
// express.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export type SessionId = ValidatedString<"SessionId">

export function newSessionId(rawValue: unknown): SessionId | undefined {
  return newValidated<"SessionId">(rawValue, SESSION_ID_PATTERN)
}
