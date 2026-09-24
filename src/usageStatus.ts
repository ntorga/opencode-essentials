import type { CostUsd } from "./valueObject/costUsd.ts"
import { newCostUsd } from "./valueObject/costUsd.ts"
import type { MessageId } from "./valueObject/messageId.ts"
import { newMessageId } from "./valueObject/messageId.ts"
import type { TimestampMs } from "./valueObject/timestampMs.ts"
import { newTimestampMs } from "./valueObject/timestampMs.ts"
import type { TokenCount } from "./valueObject/tokenCount.ts"
import { newTokenCount } from "./valueObject/tokenCount.ts"
import { isRecord } from "./valueObject/util.ts"

export type ResponseUsageStatus = {
  outputTokens: TokenCount
  tokensPerSecond: number
  firstTextMs?: number
  responseDurationMs: number
  costUsd?: CostUsd
}

type CompletedAssistantMessage = {
  id: MessageId
  createdAtMs: TimestampMs
  completedAtMs: TimestampMs
  outputTokens: TokenCount
  costUsd: CostUsd | undefined
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
    costUsd: newCostUsd(rawValue.cost),
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

function formatTokenCount(tokenCount: TokenCount): string {
  if (tokenCount >= 1_000_000) return `${(tokenCount / 1_000_000).toFixed(1)}M`
  if (tokenCount >= 1_000) return `${(tokenCount / 1_000).toFixed(1)}k`
  return String(tokenCount)
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1_000).toFixed(1)}s`
}

export function resolveResponseUsageStatus(
  rawMessages: readonly unknown[],
  readParts: (messageId: MessageId) => readonly unknown[],
): ResponseUsageStatus | undefined {
  let latestMessage: CompletedAssistantMessage | undefined
  for (const rawMessage of rawMessages) {
    const message = newCompletedAssistantMessage(rawMessage)
    if (!message) continue
    if (
      latestMessage === undefined ||
      message.completedAtMs > latestMessage.completedAtMs
    ) {
      latestMessage = message
    }
  }
  if (!latestMessage) return undefined

  const responseDurationMs =
    latestMessage.completedAtMs - latestMessage.createdAtMs
  const responseDurationSeconds = responseDurationMs / 1_000
  const tokensPerSecond = latestMessage.outputTokens / responseDurationSeconds
  if (!Number.isFinite(tokensPerSecond)) return undefined

  const firstTextMs = resolveFirstTextMs(readParts(latestMessage.id))
  const firstTextStartedAfterMessageCreation =
    firstTextMs !== undefined && firstTextMs >= latestMessage.createdAtMs
  const timeToFirstTextMs = firstTextStartedAfterMessageCreation
    ? firstTextMs - latestMessage.createdAtMs
    : undefined

  return {
    outputTokens: latestMessage.outputTokens,
    tokensPerSecond,
    firstTextMs: timeToFirstTextMs,
    responseDurationMs,
    costUsd: latestMessage.costUsd,
  }
}

export function formatResponseUsageStatus(usage: ResponseUsageStatus): string {
  const fields = [
    `${formatTokenCount(usage.outputTokens)} out`,
    `${Math.round(usage.tokensPerSecond)} tok/s`,
  ]
  if (usage.firstTextMs !== undefined) {
    fields.push(`${formatDuration(usage.firstTextMs)} first text`)
  }
  fields.push(`${formatDuration(usage.responseDurationMs)} duration`)
  if (usage.costUsd !== undefined) {
    const formattedCost = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(usage.costUsd)
    fields.push(formattedCost)
  }
  return `response · ${fields.join(" · ")}`
}
