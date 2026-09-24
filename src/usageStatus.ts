import type { MessageId } from "./valueObject/messageId.ts"
import { newMessageId } from "./valueObject/messageId.ts"
import type { TimestampMs } from "./valueObject/timestampMs.ts"
import { newTimestampMs } from "./valueObject/timestampMs.ts"
import type { TokenCount } from "./valueObject/tokenCount.ts"
import { newTokenCount } from "./valueObject/tokenCount.ts"
import { isRecord } from "./valueObject/util.ts"

const TOKEN_RATE_RESPONSE_WINDOW_SIZE = 3

export type ResponseUsageStatus = {
  averageTokensPerSecond: number
  averageFirstTextLatencyMs?: number
  averageResponseDurationMs: number
}

type CompletedAssistantMessage = {
  id: MessageId
  createdAtMs: TimestampMs
  completedAtMs: TimestampMs
  outputTokens: TokenCount
}

function newCompletedAssistantMessage(
  rawValue: unknown,
): CompletedAssistantMessage | undefined {
  if (!isRecord(rawValue) || rawValue.role !== "assistant") return undefined
  if (rawValue.summary === true) return undefined
  const id = newMessageId(rawValue.id)
  if (!id || !isRecord(rawValue.time) || !isRecord(rawValue.tokens)) {
    return undefined
  }

  const createdAtMs = newTimestampMs(rawValue.time.created)
  const completedAtMs = newTimestampMs(rawValue.time.completed)
  const outputTokens = newTokenCount(rawValue.tokens.output)
  if (
    createdAtMs === undefined ||
    completedAtMs === undefined ||
    completedAtMs <= createdAtMs ||
    outputTokens === undefined ||
    outputTokens === 0
  ) {
    return undefined
  }

  return {
    id,
    createdAtMs,
    completedAtMs,
    outputTokens,
  }
}

function resolveFirstTextMs(
  rawParts: readonly unknown[],
): TimestampMs | undefined {
  let firstTextMs: TimestampMs | undefined
  for (const rawPart of rawParts) {
    if (!isRecord(rawPart) || rawPart.type !== "text") continue
    if (rawPart.synthetic === true || rawPart.ignored === true) continue
    if (!isRecord(rawPart.time)) continue
    const partStartMs = newTimestampMs(rawPart.time.start)
    if (partStartMs === undefined) continue
    if (firstTextMs === undefined || partStartMs < firstTextMs) {
      firstTextMs = partStartMs
    }
  }
  return firstTextMs
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1_000).toFixed(1)}s`
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

  const totalOutputTokens = recentMessages.reduce(
    (total, message) => total + message.outputTokens,
    0,
  )
  const totalResponseDurationMs = recentMessages.reduce(
    (total, message) => total + (message.completedAtMs - message.createdAtMs),
    0,
  )
  const tokenRateDurationSeconds = totalResponseDurationMs / 1_000
  const averageTokensPerSecond = totalOutputTokens / tokenRateDurationSeconds
  if (!Number.isFinite(averageTokensPerSecond)) return undefined

  const firstTextLatenciesMs = recentMessages.flatMap((message) => {
    const firstTextStartedAtMs = resolveFirstTextMs(readParts(message.id))
    if (firstTextStartedAtMs === undefined) return []
    const firstTextStartedAfterMessageCreation =
      firstTextStartedAtMs >= message.createdAtMs
    if (!firstTextStartedAfterMessageCreation) return []
    return [firstTextStartedAtMs - message.createdAtMs]
  })
  const totalFirstTextLatencyMs = firstTextLatenciesMs.reduce(
    (total, latencyMs) => total + latencyMs,
    0,
  )
  const averageFirstTextLatencyMs =
    firstTextLatenciesMs.length === 0
      ? undefined
      : totalFirstTextLatencyMs / firstTextLatenciesMs.length
  const averageResponseDurationMs =
    totalResponseDurationMs / recentMessages.length

  return {
    averageTokensPerSecond,
    averageFirstTextLatencyMs,
    averageResponseDurationMs,
  }
}

export function formatResponseUsageStatus(usage: ResponseUsageStatus): string {
  const firstTextLatency =
    usage.averageFirstTextLatencyMs === undefined
      ? undefined
      : formatDuration(usage.averageFirstTextLatencyMs)
  const averageTotalLatency = formatDuration(usage.averageResponseDurationMs)
  const latencyDetails =
    firstTextLatency === undefined
      ? `total latency: ${averageTotalLatency}`
      : `first text latency: ${firstTextLatency} | total: ${averageTotalLatency}`
  return [
    `${Math.round(usage.averageTokensPerSecond)} tok/s`,
    latencyDetails,
  ].join(" · ")
}
