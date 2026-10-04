import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { AUDIT_RETENTION_MS, appendAuditRecordLine } from "./logRotation.ts"

// Note: Setup/teardown are intentionally file-local — test independence
// requires each file to own its preconditions, even if it duplicates code.

let logDir = ""
let logPath = ""
const NOW_MS = Date.parse("2026-09-26T12:00:00.000Z")

function lineAged(ageMs: number): string {
  return `${JSON.stringify({
    time: new Date(NOW_MS - ageMs).toISOString(),
    body: `age-${ageMs}`,
  })}\n`
}

function readLines(): string[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
}

beforeEach(() => {
  logDir = mkdtempSync(path.join(tmpdir(), "log-rotation-"))
  logPath = path.join(logDir, "audit.log")
})

afterEach(() => {
  rmSync(logDir, { recursive: true, force: true })
})

describe("appendAuditRecordLine", () => {
  it("creates the file and appends to a missing log", () => {
    appendAuditRecordLine(
      logPath,
      '{"time":"2026-09-26T12:00:00.000Z"}\n',
      NOW_MS,
    )
    appendAuditRecordLine(
      logPath,
      '{"time":"2026-09-26T12:00:01.000Z"}\n',
      NOW_MS,
    )
    assert.equal(readLines().length, 2)
  })

  it("drops lines older than the retention window and keeps the new line", () => {
    writeFileSync(
      logPath,
      [
        lineAged(AUDIT_RETENTION_MS + 60_000),
        lineAged(AUDIT_RETENTION_MS - 60_000),
        lineAged(1_000),
      ].join(""),
    )
    appendAuditRecordLine(logPath, lineAged(0), NOW_MS)

    const bodies = readLines().map(
      (line) => (JSON.parse(line) as { body: string }).body,
    )
    assert.deepEqual(bodies, [
      `age-${AUDIT_RETENTION_MS - 60_000}`,
      "age-1000",
      "age-0",
    ])
  })

  it("drops lines without a readable time, the damage the rewrite repairs", () => {
    writeFileSync(logPath, `not json\n${lineAged(1_000)}\n`)
    appendAuditRecordLine(logPath, lineAged(0), NOW_MS)

    assert.deepEqual(readLines(), [
      lineAged(1_000).trimEnd(),
      lineAged(0).trimEnd(),
    ])
  })

  it("empties the log when every line has aged out", () => {
    writeFileSync(logPath, lineAged(AUDIT_RETENTION_MS * 2))
    appendAuditRecordLine(logPath, lineAged(0), NOW_MS)

    assert.deepEqual(readLines(), [lineAged(0).trimEnd()])
  })
})
