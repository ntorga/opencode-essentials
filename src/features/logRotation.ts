import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { isRecord } from "../valueObject/util.ts"

export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const PRUNE_LOCK_STALE_MS = 5 * 60 * 1_000

// The code keeps a line when its recorded time sits inside the retention
// window. The format is the plugin's own, so a line without a readable time
// is damage, not data. The rewrite is also the repair point.
function isLineWithinRetention(line: string, cutoffMs: number): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return false
  }
  const time = isRecord(parsed) ? parsed.time : undefined
  if (typeof time !== "string") return false
  const lineMs = Date.parse(time)
  return Number.isFinite(lineMs) && lineMs >= cutoffMs
}

// Several terminals share one audit file, so the read-prune-append runs under
// a lock. Whoever cannot take it falls back to a plain append and defers the
// compaction, so no line is ever lost to a racing rewrite. A lock left by a
// crashed writer is cleared once it is clearly stale.
function acquirePruneLock(lockPath: string, nowMs: number): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      closeSync(openSync(lockPath, "wx"))
      return true
    } catch (failure) {
      if (!isRecord(failure) || failure.code !== "EEXIST") return false
      if (attempt === 0 && lockIsStale(lockPath, nowMs)) {
        rmSync(lockPath, { force: true })
        continue
      }
      return false
    }
  }
  return false
}

function lockIsStale(lockPath: string, nowMs: number): boolean {
  const stats = statSync(lockPath, { throwIfNoEntry: false })
  return stats !== undefined && nowMs - stats.mtimeMs > PRUNE_LOCK_STALE_MS
}

// Appends one record line and keeps the file inside the retention window in
// the same atomic rewrite. The rewrite lands through a rename so a concurrent
// reader never sees a truncated log.
export function appendAuditRecordLine(
  logPath: string,
  recordLine: string,
  nowMs: number = Date.now(),
): void {
  const lockPath = `${logPath}.lock`
  if (!acquirePruneLock(lockPath, nowMs)) {
    appendFileSync(logPath, recordLine, { mode: 0o600 })
    return
  }
  try {
    const contents = readFileSync(logPath, "utf8")
    const lines = contents.split("\n").filter((line) => line.length > 0)
    const keptLines = lines.filter((line) =>
      isLineWithinRetention(line, nowMs - AUDIT_RETENTION_MS),
    )
    keptLines.push(recordLine.replace(/\n$/, ""))
    const temporaryPath = `${logPath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, `${keptLines.join("\n")}\n`, {
      flag: "wx",
      mode: 0o600,
    })
    renameSync(temporaryPath, logPath)
  } catch {
    appendFileSync(logPath, recordLine, { mode: 0o600 })
  } finally {
    rmSync(lockPath, { force: true })
  }
}

// Shared entry for every audit log: make sure the directory exists, then run
// the retention append. It returns the failure instead of throwing so each
// feature surfaces it through its own logging channel.
export function writeAuditRecord(
  logPath: string,
  record: Record<string, unknown>,
): unknown {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 })
    appendAuditRecordLine(logPath, `${JSON.stringify(record)}\n`)
    return undefined
  } catch (failure) {
    return failure
  }
}
