import type { ValidatedString } from "./util.ts"
import { newValidated } from "./util.ts"

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export type MessageId = ValidatedString<"MessageId">

export function newMessageId(rawValue: unknown): MessageId | undefined {
  return newValidated<"MessageId">(rawValue, MESSAGE_ID_PATTERN)
}
