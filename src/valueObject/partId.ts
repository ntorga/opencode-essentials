import type { ValidatedString } from "./util.ts"
import { newValidated } from "./util.ts"

const PART_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export type PartId = ValidatedString<"PartId">

export function newPartId(rawValue: unknown): PartId | undefined {
  return newValidated<"PartId">(rawValue, PART_ID_PATTERN)
}
