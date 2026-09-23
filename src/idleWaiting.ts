import type { TimestampMs } from "./valueObject/timestampMs.ts"
import { newTimestampMs } from "./valueObject/timestampMs.ts"
import { isRecord } from "./valueObject/util.ts"

export type IdleClockMessage = {
  role: "user" | "assistant"
  completedAtMs: TimestampMs | undefined
  isCompactionSummary: boolean
}

export type IdleClockStatus = "idle" | "retry" | "busy"

export type IdleClockColor = "muted" | "warning" | "error"

export type IdleClockLine = {
  text: string
  color: IdleClockColor
}

export type IdleClockCompactor = {
  enabled: boolean
  idleTimeoutMs: number
}

const YELLOW_AFTER_IDLE_FRACTION = 0.5
const RED_AFTER_IDLE_FRACTION = 0.8

function asRole(rawValue: unknown): "user" | "assistant" | undefined {
  if (rawValue === "user" || rawValue === "assistant") return rawValue
  return undefined
}

// The sync store hands plugin code the host Message shapes. Only the role
// and time fields are read, and every number arrives through a valueObject
// constructor so a host-side shape drift drops the message instead of
// doing arithmetic on garbage.
function toIdleClockMessage(rawValue: unknown): IdleClockMessage | undefined {
  if (!isRecord(rawValue)) return undefined
  const role = asRole(rawValue.role)
  if (!role) return undefined
  const time = isRecord(rawValue.time) ? rawValue.time : undefined
  if (!time) return undefined
  return {
    role,
    completedAtMs: newTimestampMs(time.completed),
    isCompactionSummary: role === "assistant" && rawValue.summary === true,
  }
}

export function toIdleClockMessages(
  rawMessages: readonly unknown[],
): IdleClockMessage[] {
  return rawMessages.flatMap((rawMessage) => {
    const message = toIdleClockMessage(rawMessage)
    return message === undefined ? [] : [message]
  })
}

// The idle anchor is when the model stopped answering: the newest completed
// assistant turn. Only a still-streaming turn has no anchor yet. Aborted and
// errored turns complete too, and they are genuine stops into waiting. The
// auto-compactor's summary turn carries `summary: true`; it is the plugin
// answering the clock away, not the model waiting on the user, so it never
// re-anchors.
export function resolveIdleAnchorMs(
  messages: readonly IdleClockMessage[],
): TimestampMs | undefined {
  let anchorMs: TimestampMs | undefined
  for (const message of messages) {
    const completedMs = message.completedAtMs
    if (
      message.role !== "assistant" ||
      message.isCompactionSummary ||
      completedMs === undefined
    ) {
      continue
    }
    if (anchorMs === undefined || completedMs > anchorMs) anchorMs = completedMs
  }
  return anchorMs
}

export function formatIdleDuration(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

function formatIdleStartTimestamp(timestampMs: TimestampMs): string {
  return new Date(timestampMs).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  })
}

function resolveIdleClockColor(
  elapsedMs: number,
  compactor: IdleClockCompactor,
): IdleClockColor {
  if (!compactor.enabled) return "muted"
  if (elapsedMs >= compactor.idleTimeoutMs * RED_AFTER_IDLE_FRACTION) {
    return "error"
  }
  if (elapsedMs >= compactor.idleTimeoutMs * YELLOW_AFTER_IDLE_FRACTION) {
    return "warning"
  }
  return "muted"
}

// The line is shown only while the session is idle: busy or retry means the
// model is still working, and a missing status means the host has not synced
// the session yet. An unanchored or future anchor is not displayed.
export function resolveIdleClockLine(
  status: IdleClockStatus | undefined,
  messages: readonly IdleClockMessage[],
  nowMs: number,
  compactor: IdleClockCompactor,
): IdleClockLine | undefined {
  if (status !== "idle") return undefined
  const anchorMs = resolveIdleAnchorMs(messages)
  if (anchorMs === undefined) return undefined
  const elapsedMs = nowMs - anchorMs
  if (elapsedMs < 0) return undefined
  const displayDuration = formatIdleDuration(elapsedMs)
  const idleStart = formatIdleStartTimestamp(anchorMs)
  return {
    text: `idle ${displayDuration} · since ${idleStart}`,
    color: resolveIdleClockColor(elapsedMs, compactor),
  }
}
