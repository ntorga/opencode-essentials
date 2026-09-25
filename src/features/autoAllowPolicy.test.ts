import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PermissionName } from "../valueObject/permissionName.ts"
import { newPermissionName } from "../valueObject/permissionName.ts"
import { newAutoAllowReply } from "./autoAllowPolicy.ts"

function trustedPermission(name: string): PermissionName {
  const permission = newPermissionName(name)
  if (!permission) throw new Error(`TestFixturePermissionInvalid: ${name}`)
  return permission
}

describe("auto-allow reply policy", () => {
  it("remembers a safe file edit so later edits stop consulting Jev", () => {
    assert.equal(
      newAutoAllowReply(trustedPermission("edit"), "always"),
      "always",
    )
  })

  it("never answers bash with always: an rm * rule would allow rm -rf /", () => {
    assert.equal(newAutoAllowReply(trustedPermission("bash"), "always"), "once")
  })

  it("never answers external_directory with always: it widens to the directory", () => {
    assert.equal(
      newAutoAllowReply(trustedPermission("external_directory"), "always"),
      "once",
    )
  })

  it("answers an unknown permission with once", () => {
    assert.equal(
      newAutoAllowReply(trustedPermission("data_sync"), "always"),
      "once",
    )
  })

  it("honours the once preference for every permission", () => {
    for (const name of ["edit", "bash", "external_directory", "webfetch"]) {
      assert.equal(newAutoAllowReply(trustedPermission(name), "once"), "once")
    }
  })
})
