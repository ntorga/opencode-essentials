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
  value: string
  tone: StatusBarTone
  prefix?: string
  suffix?: string
}

type GenerationPartTiming = {
  firstActivityStartMs: TimestampMs | undefined
  firstTextStartMs: TimestampMs | undefined
  activeMs: number
}

function partTimeMs(
  rawPart: Record<string, unknown>,
): { startMs: TimestampMs; endMs: TimestampMs | undefined } | undefined {
  if (!isRecord(rawPart.time)) return undefined
  const startMs = newTimestampMs(rawPart.time.start)
  if (startMs === undefined) return undefined
  return { startMs, endMs: newTimestampMs(rawPart.time.end) }
}

function minMs(
  current: TimestampMs | undefined,
  candidate: TimestampMs,
): TimestampMs {
  return current === undefined || candidate < current ? candidate : current
}

function maxMs(
  current: TimestampMs | undefined,
  candidate: TimestampMs,
): TimestampMs {
  return current === undefined || candidate > current ? candidate : current
}

function toolExecutionMs(rawState: unknown): number | undefined {
  if (!isRecord(rawState)) return undefined
  if (rawState.status !== "completed" && rawState.status !== "error") {
    return undefined
  }
  if (!isRecord(rawState.time)) return undefined
  const startMs = newTimestampMs(rawState.time.start)
  const endMs = newTimestampMs(rawState.time.end)
  if (startMs === undefined || endMs === undefined || endMs <= startMs) {
    return undefined
  }
  return endMs - startMs
}

// The window spans the first to the last part timestamp. Tool execution is
// cut out: those seconds hold no model output. The gaps left behind —
// writing the next tool call, queueing, resuming after a result — are
// generation time, so they stay in.
function measureGenerationParts(
  rawParts: readonly unknown[],
): GenerationPartTiming {
  let firstActivityStartMs: TimestampMs | undefined
  let firstTextStartMs: TimestampMs | undefined
  let windowStartMs: TimestampMs | undefined
  let windowEndMs: TimestampMs | undefined
  let toolMs = 0
  for (const rawPart of rawParts) {
    if (!isRecord(rawPart)) continue
    const isText = rawPart.type === "text"
    const isReasoning = rawPart.type === "reasoning"
    const isTool = rawPart.type === "tool"
    if (!isText && !isReasoning && !isTool) continue
    if (isText && (rawPart.synthetic === true || rawPart.ignored === true)) {
      continue
    }
    if (isTool) {
      const executionMs = toolExecutionMs(rawPart.state)
      if (executionMs === undefined) continue
      if (!isRecord(rawPart.state) || !isRecord(rawPart.state.time)) continue
      const executionStartMs = newTimestampMs(rawPart.state.time.start)
      const executionEndMs = newTimestampMs(rawPart.state.time.end)
      if (executionStartMs !== undefined) {
        windowStartMs = minMs(windowStartMs, executionStartMs)
      }
      if (executionEndMs !== undefined) {
        windowEndMs = maxMs(windowEndMs, executionEndMs)
      }
      toolMs += executionMs
      continue
    }
    const part = partTimeMs(rawPart)
    if (part === undefined) continue
    windowStartMs = minMs(windowStartMs, part.startMs)
    firstActivityStartMs = minMs(firstActivityStartMs, part.startMs)
    if (part.endMs !== undefined) {
      windowEndMs = maxMs(windowEndMs, part.endMs)
    }
    if (isText) {
      firstTextStartMs = minMs(firstTextStartMs, part.startMs)
    }
  }
  const activeMs =
    windowStartMs !== undefined &&
    windowEndMs !== undefined &&
    windowEndMs > windowStartMs
      ? Math.max(0, windowEndMs - windowStartMs - toolMs)
      : 0
  return { firstActivityStartMs, firstTextStartMs, activeMs }
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
    const startedInsideMessageLifetime =
      startMs !== undefined &&
      startMs >= message.createdAtMs &&
      startMs <= message.completedAtMs
    if (!startedInsideMessageLifetime) return []
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
  const totalActiveMs = responseTimings.reduce(
    (total, response) =>
      total +
      (response.timing.activeMs > 0
        ? response.timing.activeMs
        : response.lifetimeMs),
    0,
  )
  const activeSeconds = totalActiveMs / 1_000
  const averageTokensPerSecond = totalOutputTokens / activeSeconds
  const averageGenerationTokensPerSecond =
    (totalOutputTokens + totalReasoningTokens) / activeSeconds
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
  const rateValue =
    usage.includesReasoning && generationRate !== textRate
      ? `${textRate}/${generationRate}`
      : `${textRate}`
  const segments: ResponseUsageSegment[] = [
    {
      value: rateValue,
      suffix: " tok/s",
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
    value: values.join("/"),
    prefix: "latency: ",
    tone: healthMs === undefined ? "muted" : resolveLatencyTone(healthMs),
  })
  return segments
}
