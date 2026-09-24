import type { ValidatedString } from "./util.ts"
import { newValidated } from "./util.ts"

const PERMISSION_REQUEST_ID_PATTERN = /^per[A-Za-z0-9_-]{1,128}$/

export type PermissionRequestId = ValidatedString<"PermissionRequestId">

export function newPermissionRequestId(
  rawValue: unknown,
): PermissionRequestId | undefined {
  return newValidated<"PermissionRequestId">(
    rawValue,
    PERMISSION_REQUEST_ID_PATTERN,
  )
}
