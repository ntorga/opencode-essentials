import type { ValidatedString } from "./util.ts"
import { newValidated } from "./util.ts"

const PERMISSION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/

export type PermissionName = ValidatedString<"PermissionName">

export function newPermissionName(
  rawValue: unknown,
): PermissionName | undefined {
  return newValidated<"PermissionName">(rawValue, PERMISSION_NAME_PATTERN)
}
