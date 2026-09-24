import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import type { OpenRouterModelId } from "../valueObject/openRouterModelId.ts"
import { newOpenRouterModelId } from "../valueObject/openRouterModelId.ts"
import type { PermissionRequest } from "../valueObject/permissionRequest.ts"
import { newPermissionRequest } from "../valueObject/permissionRequest.ts"
import {
  auditPermissionClassification,
  auditPermissionDecision,
  resolvePermissionAuditLogPath,
} from "./permissionAudit.ts"

function trustedRequest(patterns: string[]): PermissionRequest {
  const request = newPermissionRequest({
    id: "per_test_1",
    sessionID: "ses_test_1",
    permission: "bash",
    patterns,
  })
  if (!request) throw new Error(`TestFixtureRequestInvalid: ${patterns}`)
  return request
}

function trustedModel(model: string): OpenRouterModelId {
  const validated = newOpenRouterModelId(model)
  if (!validated) throw new Error(`TestFixtureModelInvalid: ${model}`)
  return validated
}

function readAuditLines(): Record<string, unknown>[] {
  const contents = readFileSync(resolvePermissionAuditLogPath(), "utf8")
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

// Note: Setup/teardown are intentionally inline — test independence
// requires each file to own its preconditions, even if it duplicates code.

let dataHomeTemp = ""
let previousDataHome: string | undefined

beforeEach(() => {
  previousDataHome = process.env.XDG_DATA_HOME
  dataHomeTemp = mkdtempSync(path.join(tmpdir(), "permission-audit-"))
  process.env.XDG_DATA_HOME = dataHomeTemp
})

afterEach(() => {
  const logPath = resolvePermissionAuditLogPath()
  if (existsSync(logPath)) chmodSync(logPath, 0o600)
  process.env.XDG_DATA_HOME = previousDataHome ?? ""
  rmSync(dataHomeTemp, { recursive: true, force: true })
})

describe("permission audit log", () => {
  it("appends a classification line with the model, probability, and verdict", () => {
    const failure = auditPermissionClassification({
      request: trustedRequest(["git status"]),
      projectDirectory: "/home/dev/project",
      model: trustedModel("typesafe/jev-1.13"),
      probability: 0.97,
      autoAllowed: true,
    })
    assert.equal(failure, undefined)
    const [line] = readAuditLines()
    assert.equal(line?.type, "classification")
    assert.equal(line?.model, "typesafe/jev-1.13")
    assert.equal(line?.probability, 0.97)
    assert.equal(line?.autoAllowed, true)
    assert.deepEqual(line?.patterns, ["git status"])
    assert.equal(line?.project, "/home/dev/project")
    assert.equal(line?.session, "ses_test_1")
    assert.equal(line?.permission, "bash")
    assert.equal(line?.requestID, "per_test_1")
    assert.equal(typeof line?.time, "string")
  })

  it("appends decision lines for every actor and keeps one line per event", () => {
    auditPermissionDecision({
      request: trustedRequest(["rm -rf build"]),
      projectDirectory: "/home/dev/project",
      actor: "classifier",
      reply: "once",
    })
    auditPermissionDecision({
      request: trustedRequest(["git push"]),
      projectDirectory: "/home/dev/project",
      actor: "user",
      reply: "reject",
    })
    auditPermissionDecision({
      request: trustedRequest(["git status"]),
      projectDirectory: "/home/dev/project",
      actor: "assistant",
      reply: "reject",
    })
    const lines = readAuditLines()
    assert.equal(lines.length, 3)
    assert.deepEqual(
      lines.map((line) => [line.actor, line.reply, line.patterns]),
      [
        ["classifier", "once", ["rm -rf build"]],
        ["user", "reject", ["git push"]],
        ["assistant", "reject", ["git status"]],
      ],
    )
  })

  it("replaces control characters inside command patterns", () => {
    auditPermissionDecision({
      request: trustedRequest(["echo safe\u001b]0;forged\u0007"]),
      projectDirectory: "/home/dev/project",
      actor: "user",
      reply: "once",
    })
    const [line] = readAuditLines()
    if (!line) throw new Error("TestFixtureAuditLineMissing")
    const [pattern] = line.patterns as string[]
    assert.doesNotMatch(pattern, /\p{Cc}/u)
  })

  it("marks and shortens patterns longer than the audit limit", () => {
    const longPattern = "x".repeat(2_001)
    auditPermissionDecision({
      request: trustedRequest([longPattern]),
      projectDirectory: "/home/dev/project",
      actor: "classifier",
      reply: "once",
    })
    const [line] = readAuditLines()
    if (!line) throw new Error("TestFixtureAuditLineMissing")
    assert.equal(line.truncated, true)
    const [pattern] = line.patterns as string[]
    assert.equal(pattern.length, 2_000)
  })

  it("returns the failure when the audit file cannot be written", () => {
    const firstFailure = auditPermissionDecision({
      request: trustedRequest(["git status"]),
      projectDirectory: "/home/dev/project",
      actor: "user",
      reply: "once",
    })
    assert.equal(firstFailure, undefined)
    chmodSync(resolvePermissionAuditLogPath(), 0o400)
    const secondFailure = auditPermissionDecision({
      request: trustedRequest(["git status"]),
      projectDirectory: "/home/dev/project",
      actor: "user",
      reply: "once",
    })
    assert.ok(secondFailure instanceof Error)
  })
})
