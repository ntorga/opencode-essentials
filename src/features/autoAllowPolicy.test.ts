import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PermissionName } from "../valueObject/permissionName.ts"
import { newPermissionName } from "../valueObject/permissionName.ts"
import { shouldRememberApproval } from "./autoAllowPolicy.ts"

function trustedPermission(name: string): PermissionName {
  const permission = newPermissionName(name)
  if (!permission) throw new Error(`TestFixturePermissionInvalid: ${name}`)
  return permission
}

describe("auto-allow remember policy", () => {
  it("remembers a safe file edit when the preference is to remember", () => {
    assert.equal(
      shouldRememberApproval(trustedPermission("edit"), "always"),
      true,
    )
  })

  it("never remembers a bash command: a cached command would skip its check", () => {
    assert.equal(
      shouldRememberApproval(trustedPermission("bash"), "always"),
      false,
    )
  })

  it("never remembers an external directory write", () => {
    assert.equal(
      shouldRememberApproval(trustedPermission("external_directory"), "always"),
      false,
    )
  })

  it("never remembers an unknown permission", () => {
    assert.equal(
      shouldRememberApproval(trustedPermission("data_sync"), "always"),
      false,
    )
  })

  it("remembers nothing when the preference is ask-every-time", () => {
    for (const name of ["edit", "bash", "external_directory", "webfetch"]) {
      assert.equal(
        shouldRememberApproval(trustedPermission(name), "once"),
        false,
      )
    }
  })
})
