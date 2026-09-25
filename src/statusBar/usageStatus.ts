import type { CompletedAssistantMessage } from "../documents/completedAssistantMessage.ts"
import { newCompletedAssistantMessage } from "../documents/completedAssistantMessage.ts"
import type { MessageId } from "../valueObject/messageId.ts"
import type { TimestampMs } from "../valueObject/timestampMs.ts"
import { newTimestampMs } from "../valueObject/timestampMs.ts"
import { isRecord } from "../valueObject/util.ts"
import type { StatusBarTone } from "./tone.ts"

const TOKEN_RATE_ERROR_TPS = 20
const TOKEN_RATE_WARNING_TPS = 40
const LATENCY_ERROR_MS = 10_000
const LATENCY_WARNING_MS = 3_000
const RESPONSE_WINDOW_MS = 5 * 60_000
const RESPONSE_WINDOW_SIZE = 18
const HEALTH_MIN_RESPONSES = 3
const HEALTH_FLIP_SHARE = 1 / 3

export type ResponseHealthLevel = "healthy" | "degraded" | "underperforming"

export type ResponseUsageSegment = {
  value: string
  tone: StatusBarTone
  prefix?: string
  suffix?: string
  // Glue drawn before the segment when another segment precedes it. The
  // renderer falls back to its standard join when a segment stays silent.
  separator?: string
}

export type ResponseStatus = {
  healthLevel: ResponseHealthLevel | undefined
  averageTokensPerSecond: number
  averageGenerationTokensPerSecond: number
  includesReasoning: boolean
  averageFirstActivityLatencyMs: number | undefined
  averageFirstTextLatencyMs: number | undefined
}

type GenerationPartTiming = {
  firstActivityStartMs: TimestampMs | undefined
  firstTextStartMs: TimestampMs | undefined
  activeMs: number
}

type ResponseGrade = "good" | "troubled" | "poor"

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

function latencySinceMessageStart(
  message: CompletedAssistantMessage,
  startMs: TimestampMs | undefined,
): number | undefined {
  if (
    startMs === undefined ||
    startMs < message.createdAtMs ||
    startMs > message.completedAtMs
  ) {
    return undefined
  }
  return startMs - message.createdAtMs
}

// A response whose parts yield no positive measured window leaves only the
// message lifetime to divide the tokens by.
function responseActiveMs(response: ResponseTiming): number {
  return response.timing.activeMs > 0
    ? response.timing.activeMs
    : response.lifetimeMs
}

function measureResponseTiming(
  message: CompletedAssistantMessage,
  readParts: (messageId: MessageId) => readonly unknown[],
): ResponseTiming {
  return {
    message,
    lifetimeMs: message.completedAtMs - message.createdAtMs,
    timing: measureGenerationParts(readParts(message.id)),
  }
}

function averageLatencyMs(
  responseTimings: readonly ResponseTiming[],
  readStartMs: (timing: GenerationPartTiming) => TimestampMs | undefined,
): number | undefined {
  const latenciesMs = responseTimings.flatMap(({ message, timing }) => {
    const latencyMs = latencySinceMessageStart(message, readStartMs(timing))
    return latencyMs === undefined ? [] : [latencyMs]
  })
  if (latenciesMs.length === 0) return undefined
  return (
    latenciesMs.reduce((total, latencyMs) => total + latencyMs, 0) /
    latenciesMs.length
  )
}

function windowResponseTimings(
  rawMessages: readonly unknown[],
  readParts: (messageId: MessageId) => readonly unknown[],
  nowMs: number,
): ResponseTiming[] {
  return rawMessages
    .flatMap((rawMessage) => {
      const message = newCompletedAssistantMessage(rawMessage)
      return message === undefined ? [] : [message]
    })
    .toSorted((first, second) => second.completedAtMs - first.completedAtMs)
    .filter((message) => message.completedAtMs >= nowMs - RESPONSE_WINDOW_MS)
    .slice(0, RESPONSE_WINDOW_SIZE)
    .map((message) => measureResponseTiming(message, readParts))
}

function gradeResponseTiming(response: ResponseTiming): ResponseGrade {
  const startLatencyMs = latencySinceMessageStart(
    response.message,
    response.timing.firstActivityStartMs,
  )
  const tones: StatusBarTone[] = [
    resolveTokenRateTone(
      response.message.outputTokens / (responseActiveMs(response) / 1_000),
    ),
  ]
  if (startLatencyMs !== undefined)
    tones.push(resolveLatencyTone(startLatencyMs))
  if (tones.includes("error")) return "poor"
  if (tones.includes("warning")) return "troubled"
  return "good"
}

// A verdict needs a streak to read: fewer than HEALTH_MIN_RESPONSES
// completed responses in the window say nothing about the provider's habit.
function resolveHealthLevel(
  grades: readonly ResponseGrade[],
): ResponseHealthLevel | undefined {
  if (grades.length < HEALTH_MIN_RESPONSES) return undefined
  const troubledCount = grades.filter(
    (grade) => grade === "troubled" || grade === "poor",
  ).length
  const poorCount = grades.filter((grade) => grade === "poor").length
  if (poorCount / grades.length >= HEALTH_FLIP_SHARE) return "underperforming"
  if (troubledCount / grades.length >= HEALTH_FLIP_SHARE) return "degraded"
  return "healthy"
}

export function resolveResponseStatus(
  rawMessages: readonly unknown[],
  readParts: (messageId: MessageId) => readonly unknown[],
  nowMs: number,
): ResponseStatus | undefined {
  const responseTimings = windowResponseTimings(rawMessages, readParts, nowMs)
  if (responseTimings.length === 0) return undefined

  const totalOutputTokens = responseTimings.reduce(
    (total, response) => total + response.message.outputTokens,
    0,
  )
  const totalReasoningTokens = responseTimings.reduce(
    (total, response) => total + response.message.reasoningTokens,
    0,
  )
  const totalActiveMs = responseTimings.reduce(
    (total, response) => total + responseActiveMs(response),
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

  return {
    healthLevel: resolveHealthLevel(responseTimings.map(gradeResponseTiming)),
    averageTokensPerSecond,
    averageGenerationTokensPerSecond,
    includesReasoning: totalReasoningTokens > 0,
    averageFirstActivityLatencyMs: averageLatencyMs(
      responseTimings,
      (timing) => timing.firstActivityStartMs,
    ),
    averageFirstTextLatencyMs: averageLatencyMs(
      responseTimings,
      (timing) => timing.firstTextStartMs,
    ),
  }
}

function healthSegment(
  level: ResponseHealthLevel | undefined,
): ResponseUsageSegment | undefined {
  if (level === "underperforming") return { value: level, tone: "error" }
  if (level === "degraded") return { value: level, tone: "warning" }
  if (level === "healthy") return { value: level, tone: "good" }
  return undefined
}

// The line reads `healthy (62/118 tok/s ~ 0.4s/11.3s)`: the verdict leads
// and the numbers that justify it follow in brackets. The brackets only
// group a full reading — a verdict alone, or bare numbers without one, join
// with the row's standard separator instead.
export function formatResponseStatus(
  status: ResponseStatus,
): ResponseUsageSegment[] {
  const segments: ResponseUsageSegment[] = []
  const verdict = healthSegment(status.healthLevel)
  if (verdict) segments.push(verdict)

  const activityMs = status.averageFirstActivityLatencyMs
  const textMs = status.averageFirstTextLatencyMs
  const waitsMs: number[] = []
  if (activityMs !== undefined) waitsMs.push(activityMs)
  if (
    textMs !== undefined &&
    formatDuration(textMs) !== formatDuration(activityMs ?? Number.NaN)
  ) {
    waitsMs.push(textMs)
  }
  const bracketed = verdict !== undefined && waitsMs.length > 0

  const textRate = Math.round(status.averageTokensPerSecond)
  const generationRate = Math.round(status.averageGenerationTokensPerSecond)
  const rateValue =
    status.includesReasoning && generationRate !== textRate
      ? `${textRate}/${generationRate}`
      : `${textRate}`
  const rateSegment: ResponseUsageSegment = {
    value: rateValue,
    tone: resolveTokenRateTone(status.averageTokensPerSecond),
    suffix: " tok/s",
  }
  if (bracketed) {
    rateSegment.prefix = "("
    rateSegment.separator = " "
  }
  segments.push(rateSegment)

  if (waitsMs.length === 0) return segments
  const toneStartMs = activityMs ?? textMs
  const waitsSegment: ResponseUsageSegment = {
    value: waitsMs.map((waitMs) => formatDuration(waitMs)).join("/"),
    tone: toneStartMs === undefined ? "muted" : resolveLatencyTone(toneStartMs),
    separator: " ~ ",
  }
  if (bracketed) waitsSegment.suffix = ")"
  segments.push(waitsSegment)
  return segments
}
