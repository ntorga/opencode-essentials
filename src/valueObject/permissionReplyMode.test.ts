import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  DEFAULT_AUTO_ALLOW_REPLY,
  newPermissionReplyMode,
} from "./permissionReplyMode.ts"

describe("PermissionReplyMode", () => {
  for (const accepted of ["once", "always"] as const) {
    it(`accepts ${accepted}`, () => {
      assert.equal(newPermissionReplyMode(accepted), accepted)
    })
  }

  const rejected: unknown[] = [
    undefined,
    null,
    "reject",
    "ONCE",
    "",
    true,
    0,
    {},
  ]

  for (const candidate of rejected) {
    it(`rejects ${String(candidate)}`, () => {
      assert.equal(newPermissionReplyMode(candidate), undefined)
    })
  }

  it("defaults the auto-allow reply to always", () => {
    assert.equal(DEFAULT_AUTO_ALLOW_REPLY, "always")
  })
})
