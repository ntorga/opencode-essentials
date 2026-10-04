import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import type { OpenRouterModelId } from "../valueObject/openRouterModelId.ts"
import { newOpenRouterModelId } from "../valueObject/openRouterModelId.ts"
import type { SessionId } from "../valueObject/sessionId.ts"
import { newSessionId } from "../valueObject/sessionId.ts"
import {
  auditReasoningLoopCheck,
  resolveReasoningLoopAuditLogPath,
} from "./reasoningLoopAudit.ts"

// Note: Setup/teardown are intentionally file-local — test independence
// requires each file to own its preconditions, even if it duplicates code.

let dataHomeTemp = ""
let previousDataHome: string | undefined

beforeEach(() => {
  previousDataHome = process.env.XDG_DATA_HOME
  dataHomeTemp = mkdtempSync(path.join(tmpdir(), "reasoning-loop-audit-"))
  process.env.XDG_DATA_HOME = dataHomeTemp
})

afterEach(() => {
  process.env.XDG_DATA_HOME = previousDataHome ?? ""
  rmSync(dataHomeTemp, { recursive: true, force: true })
})

function trustedSession(value: string): SessionId {
  const sessionId = newSessionId(value)
  if (!sessionId) throw new Error(`TestFixtureSessionInvalid: ${value}`)
  return sessionId
}

function trustedModel(model: string): OpenRouterModelId {
  const validated = newOpenRouterModelId(model)
  if (!validated) throw new Error(`TestFixtureModelInvalid: ${model}`)
  return validated
}

function readAuditLines(): Record<string, unknown>[] {
  return readFileSync(resolveReasoningLoopAuditLogPath(), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("reasoning loop audit log", () => {
  it("appends one line per spiral check with the verdict fields", () => {
    const failure = auditReasoningLoopCheck({
      sessionId: trustedSession("ses_test_1"),
      model: trustedModel("typesafe/jev-1.13"),
      probability: 0.95,
      outcome: "confirmed",
      phrase: "the same thought over and over",
    })
    auditReasoningLoopCheck({
      sessionId: trustedSession("ses_test_2"),
      model: trustedModel("typesafe/jev-1.13"),
      probability: undefined,
      outcome: "failed",
      phrase: "the same thought over and over",
    })

    assert.equal(failure, undefined)
    const lines = readAuditLines()
    assert.equal(lines.length, 2)
    assert.deepEqual(lines[0], {
      time: lines[0]?.time,
      session: "ses_test_1",
      model: "typesafe/jev-1.13",
      probability: 0.95,
      outcome: "confirmed",
      phrase: "the same thought over and over",
    })
    assert.equal(typeof lines[0]?.time, "string")
    assert.equal(lines[1]?.probability, null)
    assert.equal(lines[1]?.outcome, "failed")
  })

  it("shortens and cleans the repeated phrase", () => {
    auditReasoningLoopCheck({
      sessionId: trustedSession("ses_test_1"),
      model: trustedModel("typesafe/jev-1.13"),
      probability: 0.9,
      outcome: "confirmed",
      phrase: `spiral\u001b]0;forged\u0007${"x".repeat(300)}`,
    })
    const [line] = readAuditLines()
    const phrase = String(line?.phrase)
    assert.equal(phrase.length, 200)
    assert.doesNotMatch(phrase, /\p{Cc}/u)
  })
})
