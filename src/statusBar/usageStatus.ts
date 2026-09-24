import type { CompletedAssistantMessage } from "../documents/completedAssistantMessage.ts"
import { newCompletedAssistantMessage } from "../documents/completedAssistantMessage.ts"
import type { MessageId } from "../valueObject/messageId.ts"
import type { TimestampMs } from "../valueObject/timestampMs.ts"
import { newTimestampMs } from "../valueObject/timestampMs.ts"
import { isRecord } from "../valueObject/util.ts"
import type { StatusBarTone } from "./tone.ts"

const TOKEN_RATE_RESPONSE_WINDOW_SIZE = 3
const TOKEN_RATE_ERROR_TPS = 20
const TOKEN_RATE_WARNING_TPS = 40
const LATENCY_ERROR_MS = 10_000
const LATENCY_WARNING_MS = 3_000

export type ResponseUsageStatus = {
  averageTokensPerSecond: number
  averageGenerationTokensPerSecond: number
  includesReasoning: boolean
  averageFirstActivityLatencyMs?: number
  averageFirstTextLatencyMs?: number
  averageResponseDurationMs: number
}

export type ResponseUsageSegment = {
  text: string
  tone: StatusBarTone
}

type GenerationPartTiming = {
  firstActivityStartMs: TimestampMs | undefined
  firstTextStartMs: TimestampMs | undefined
  textMs: number
  reasoningMs: number
}

function partTimeMs(
  rawPart: Record<string, unknown>,
): { startMs: TimestampMs; endMs: TimestampMs | undefined } | undefined {
  if (!isRecord(rawPart.time)) return undefined
  const startMs = newTimestampMs(rawPart.time.start)
  if (startMs === undefined) return undefined
  return { startMs, endMs: newTimestampMs(rawPart.time.end) }
}

function measureGenerationParts(
  rawParts: readonly unknown[],
): GenerationPartTiming {
  let firstActivityStartMs: TimestampMs | undefined
  let firstTextStartMs: TimestampMs | undefined
  let textMs = 0
  let reasoningMs = 0
  for (const rawPart of rawParts) {
    if (!isRecord(rawPart)) continue
    const isText = rawPart.type === "text"
    const isReasoning = rawPart.type === "reasoning"
    if (!isText && !isReasoning) continue
    if (isText && (rawPart.synthetic === true || rawPart.ignored === true)) {
      continue
    }
    const part = partTimeMs(rawPart)
    if (part === undefined) continue
    if (
      firstActivityStartMs === undefined ||
      part.startMs < firstActivityStartMs
    ) {
      firstActivityStartMs = part.startMs
    }
    if (!isText) {
      if (part.endMs !== undefined && part.endMs > part.startMs) {
        reasoningMs += part.endMs - part.startMs
      }
      continue
    }
    if (firstTextStartMs === undefined || part.startMs < firstTextStartMs) {
      firstTextStartMs = part.startMs
    }
    if (part.endMs !== undefined && part.endMs > part.startMs) {
      textMs += part.endMs - part.startMs
    }
  }
  return { firstActivityStartMs, firstTextStartMs, textMs, reasoningMs }
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

function resolveLatencyTone(latencyMs: number): StatusBarTone {
  if (latencyMs > LATENCY_ERROR_MS) return "error"
  if (latencyMs > LATENCY_WARNING_MS) return "warning"
  return "muted"
}

type ResponseTiming = {
  message: CompletedAssistantMessage
  lifetimeMs: number
  timing: GenerationPartTiming
}

function averageLatencyMs(
  responseTimings: readonly ResponseTiming[],
  readStartMs: (timing: GenerationPartTiming) => TimestampMs | undefined,
): number | undefined {
  const latenciesMs = responseTimings.flatMap(({ message, timing }) => {
    const startMs = readStartMs(timing)
    if (startMs === undefined || startMs < message.createdAtMs) return []
    return [startMs - message.createdAtMs]
  })
  if (latenciesMs.length === 0) return undefined
  return (
    latenciesMs.reduce((total, latencyMs) => total + latencyMs, 0) /
    latenciesMs.length
  )
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
    timing: measureGenerationParts(readParts(message.id)),
  }))

  const totalOutputTokens = recentMessages.reduce(
    (total, message) => total + message.outputTokens,
    0,
  )
  const totalReasoningTokens = recentMessages.reduce(
    (total, message) => total + message.reasoningTokens,
    0,
  )
  const totalTextMs = responseTimings.reduce(
    (total, response) =>
      total +
      (response.timing.textMs > 0
        ? response.timing.textMs
        : response.lifetimeMs),
    0,
  )
  const totalReasoningMs = responseTimings.reduce(
    (total, response) => total + response.timing.reasoningMs,
    0,
  )
  const averageTokensPerSecond = totalOutputTokens / (totalTextMs / 1_000)
  const averageGenerationTokensPerSecond =
    (totalOutputTokens + totalReasoningTokens) /
    ((totalTextMs + totalReasoningMs) / 1_000)
  if (
    !Number.isFinite(averageTokensPerSecond) ||
    !Number.isFinite(averageGenerationTokensPerSecond)
  ) {
    return undefined
  }

  const averageFirstActivityLatencyMs = averageLatencyMs(
    responseTimings,
    (timing) => timing.firstActivityStartMs,
  )
  const averageFirstTextLatencyMs = averageLatencyMs(
    responseTimings,
    (timing) => timing.firstTextStartMs,
  )
  const totalLifetimeMs = responseTimings.reduce(
    (total, response) => total + response.lifetimeMs,
    0,
  )
  const averageResponseDurationMs = totalLifetimeMs / recentMessages.length

  return {
    averageTokensPerSecond,
    averageGenerationTokensPerSecond,
    includesReasoning: totalReasoningTokens > 0,
    averageFirstActivityLatencyMs,
    averageFirstTextLatencyMs,
    averageResponseDurationMs,
  }
}

export function formatResponseUsageStatus(
  usage: ResponseUsageStatus,
): ResponseUsageSegment[] {
  const textRate = Math.round(usage.averageTokensPerSecond)
  const generationRate = Math.round(usage.averageGenerationTokensPerSecond)
  const rateText =
    usage.includesReasoning && generationRate !== textRate
      ? `${textRate}/${generationRate} tok/s`
      : `${textRate} tok/s`
  const segments: ResponseUsageSegment[] = [
    {
      text: rateText,
      tone: resolveTokenRateTone(usage.averageTokensPerSecond),
    },
  ]
  const activityMs = usage.averageFirstActivityLatencyMs
  const textMs = usage.averageFirstTextLatencyMs
  const waitsMs: number[] = []
  if (activityMs !== undefined) waitsMs.push(activityMs)
  if (
    textMs !== undefined &&
    formatDuration(textMs) !== formatDuration(activityMs ?? Number.NaN)
  ) {
    waitsMs.push(textMs)
  }
  const values = [
    ...waitsMs.map((waitMs) => formatDuration(waitMs)),
    formatDuration(usage.averageResponseDurationMs),
  ]
  const healthMs = activityMs ?? textMs
  segments.push({
    text: `latency: ${values.join("/")}`,
    tone: healthMs === undefined ? "muted" : resolveLatencyTone(healthMs),
  })
  return segments
}
