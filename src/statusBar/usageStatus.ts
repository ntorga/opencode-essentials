import { newCompletedAssistantMessage } from "../documents/completedAssistantMessage.ts"
import type { MessageId } from "../valueObject/messageId.ts"
import type { TimestampMs } from "../valueObject/timestampMs.ts"
import { newTimestampMs } from "../valueObject/timestampMs.ts"
import { isRecord } from "../valueObject/util.ts"
import type { StatusBarTone } from "./tone.ts"

const TOKEN_RATE_RESPONSE_WINDOW_SIZE = 3
const TOKEN_RATE_ERROR_TPS = 20
const TOKEN_RATE_WARNING_TPS = 40
const FIRST_TEXT_LATENCY_ERROR_MS = 10_000
const FIRST_TEXT_LATENCY_WARNING_MS = 3_000

export type ResponseUsageStatus = {
  averageTokensPerSecond: number
  averageFirstTextLatencyMs?: number
  averageResponseDurationMs: number
}

export type ResponseUsageSegment = {
  text: string
  tone: StatusBarTone
}

type TextPartTiming = {
  firstTextStartMs: TimestampMs | undefined
  generatedMs: number
}

function measureTextParts(rawParts: readonly unknown[]): TextPartTiming {
  let firstTextStartMs: TimestampMs | undefined
  let generatedMs = 0
  for (const rawPart of rawParts) {
    if (!isRecord(rawPart) || rawPart.type !== "text") continue
    if (rawPart.synthetic === true || rawPart.ignored === true) continue
    if (!isRecord(rawPart.time)) continue
    const partStartMs = newTimestampMs(rawPart.time.start)
    if (partStartMs === undefined) continue
    if (firstTextStartMs === undefined || partStartMs < firstTextStartMs) {
      firstTextStartMs = partStartMs
    }
    const partEndMs = newTimestampMs(rawPart.time.end)
    if (partEndMs !== undefined && partEndMs > partStartMs) {
      generatedMs += partEndMs - partStartMs
    }
  }
  return { firstTextStartMs, generatedMs }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1_000).toFixed(1)}s`
}

function resolveTokenRateTone(tokensPerSecond: number): StatusBarTone {
  if (tokensPerSecond < TOKEN_RATE_ERROR_TPS) return "error"
  if (tokensPerSecond < TOKEN_RATE_WARNING_TPS) return "warning"
  return "muted"
}

function resolveFirstTextLatencyTone(latencyMs: number): StatusBarTone {
  if (latencyMs > FIRST_TEXT_LATENCY_ERROR_MS) return "error"
  if (latencyMs > FIRST_TEXT_LATENCY_WARNING_MS) return "warning"
  return "muted"
}

export function resolveResponseUsageStatus(
  rawMessages: readonly unknown[],
  readParts: (messageId: MessageId) => readonly unknown[],
): ResponseUsageStatus | undefined {
  const recentMessages = rawMessages
    .flatMap((rawMessage) => {
      const message = newCompletedAssistantMessage(rawMessage)
      return message === undefined ? [] : [message]
    })
    .toSorted((first, second) => second.completedAtMs - first.completedAtMs)
    .slice(0, TOKEN_RATE_RESPONSE_WINDOW_SIZE)
  if (recentMessages.length === 0) return undefined

  const responseTimings = recentMessages.map((message) => ({
    message,
    lifetimeMs: message.completedAtMs - message.createdAtMs,
    timing: measureTextParts(readParts(message.id)),
  }))

  const totalOutputTokens = recentMessages.reduce(
    (total, message) => total + message.outputTokens,
    0,
  )
  const totalGeneratedMs = responseTimings.reduce(
    (total, response) =>
      total +
      (response.timing.generatedMs > 0
        ? response.timing.generatedMs
        : response.lifetimeMs),
    0,
  )
  const tokenRateDurationSeconds = totalGeneratedMs / 1_000
  const averageTokensPerSecond = totalOutputTokens / tokenRateDurationSeconds
  if (!Number.isFinite(averageTokensPerSecond)) return undefined

  const firstTextLatenciesMs = responseTimings.flatMap(
    ({ message, timing: { firstTextStartMs } }) => {
      if (firstTextStartMs === undefined) return []
      const firstTextStartedAfterMessageCreation =
        firstTextStartMs >= message.createdAtMs
      if (!firstTextStartedAfterMessageCreation) return []
      return [firstTextStartMs - message.createdAtMs]
    },
  )
  const totalFirstTextLatencyMs = firstTextLatenciesMs.reduce(
    (total, latencyMs) => total + latencyMs,
    0,
  )
  const averageFirstTextLatencyMs =
    firstTextLatenciesMs.length === 0
      ? undefined
      : totalFirstTextLatencyMs / firstTextLatenciesMs.length
  const totalLifetimeMs = responseTimings.reduce(
    (total, response) => total + response.lifetimeMs,
    0,
  )
  const averageResponseDurationMs = totalLifetimeMs / recentMessages.length

  return {
    averageTokensPerSecond,
    averageFirstTextLatencyMs,
    averageResponseDurationMs,
  }
}

export function formatResponseUsageStatus(
  usage: ResponseUsageStatus,
): ResponseUsageSegment[] {
  const segments: ResponseUsageSegment[] = [
    {
      text: `${Math.round(usage.averageTokensPerSecond)} tok/s`,
      tone: resolveTokenRateTone(usage.averageTokensPerSecond),
    },
  ]
  if (usage.averageFirstTextLatencyMs !== undefined) {
    segments.push({
      text: `first text latency: ${formatDuration(usage.averageFirstTextLatencyMs)}`,
      tone: resolveFirstTextLatencyTone(usage.averageFirstTextLatencyMs),
    })
  }
  segments.push({
    text: `total: ${formatDuration(usage.averageResponseDurationMs)}`,
    tone: "muted",
  })
  return segments
}
