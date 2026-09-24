import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { newPermissionRequest } from "./permissionRequest.ts"

describe("newPermissionRequest", () => {
  it("validates the request id and permission before keeping patterns", () => {
    assert.deepEqual(
      newPermissionRequest({
        id: "per_123",
        permission: "bash",
        patterns: ["git status"],
      }),
      {
        id: "per_123",
        permission: "bash",
        patterns: ["git status"],
      },
    )
  })

  const invalidRequests: unknown[] = [
    null,
    {},
    { id: "invalid", permission: "bash", patterns: ["git status"] },
    { id: "per_123", permission: "bad permission", patterns: ["git status"] },
    { id: "per_123", permission: "bash", patterns: "git status" },
    { id: "per_123", permission: "bash", patterns: ["git status", 1] },
  ]

  for (const request of invalidRequests) {
    it(`rejects ${JSON.stringify(request)}`, () => {
      assert.equal(newPermissionRequest(request), undefined)
    })
  }
})
