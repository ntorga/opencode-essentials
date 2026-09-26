import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PermissionName } from "../valueObject/permissionName.ts"
import { newPermissionName } from "../valueObject/permissionName.ts"
import {
  newPermissionMemory,
  type PermissionMemory,
} from "./permissionMemory.ts"

function trustedPermission(name: string): PermissionName {
  const permission = newPermissionName(name)
  if (!permission) throw new Error(`TestFixturePermissionInvalid: ${name}`)
  return permission
}

const sessionA = "ses_a"
const sessionB = "ses_b"
const edit = trustedPermission("edit")
const read = trustedPermission("read")

function entry(
  sessionID: string,
  permission: PermissionName = edit,
  patterns: string[] = ["src/foo.ts"],
) {
  return { sessionID, permission, patterns }
}

function seed(memory: PermissionMemory, count: number, sessionID = sessionA) {
  for (let index = 0; index < count; index++) {
    memory.remember(entry(sessionID, edit, [`src/f${index}.ts`]))
  }
}

describe("permission memory", () => {
  it("recalls a remembered approval", () => {
    const memory = newPermissionMemory()
    memory.remember(entry(sessionA))
    assert.equal(memory.recall(entry(sessionA)), true)
  })

  it("does not recall a path it never saw", () => {
    const memory = newPermissionMemory()
    memory.remember(entry(sessionA))
    assert.equal(memory.recall(entry(sessionA, edit, ["src/bar.ts"])), false)
  })

  it("keeps sessions apart", () => {
    const memory = newPermissionMemory()
    memory.remember(entry(sessionA))
    assert.equal(memory.recall(entry(sessionB)), false)
  })

  it("keys by permission as well as path", () => {
    const memory = newPermissionMemory()
    memory.remember(entry(sessionA, edit))
    assert.equal(memory.recall(entry(sessionA, read)), false)
  })

  it("does not let a joined pattern collide with a split one", () => {
    const memory = newPermissionMemory()
    memory.remember(entry(sessionA, edit, ["a", "b"]))
    assert.equal(memory.recall(entry(sessionA, edit, ["a\nb"])), false)
    assert.equal(memory.recall(entry(sessionA, edit, ["a", "b"])), true)
  })

  it("clears a session on delete", () => {
    const memory = newPermissionMemory()
    memory.remember(entry(sessionA))
    memory.forgetSession(sessionA)
    assert.equal(memory.recall(entry(sessionA)), false)
  })

  it("caps paths per session, evicting the oldest", () => {
    const memory = newPermissionMemory()
    seed(memory, 300)
    assert.equal(memory.recall(entry(sessionA, edit, ["src/f0.ts"])), false)
    assert.equal(memory.recall(entry(sessionA, edit, ["src/f299.ts"])), true)
  })

  it("caps tracked sessions, evicting the oldest", () => {
    const memory = newPermissionMemory()
    for (let index = 0; index < 70; index++) {
      memory.remember(entry(`ses_${index}`))
    }
    assert.equal(memory.trackedSessionCount() <= 64, true)
    assert.equal(memory.recall(entry("ses_0")), false)
  })
})
