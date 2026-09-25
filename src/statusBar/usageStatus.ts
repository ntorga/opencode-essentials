import type { CompletedAssistantMessage } from "../documents/completedAssistantMessage.ts"
import { newCompletedAssistantMessage } from "../documents/completedAssistantMessage.ts"
import type { MessageId } from "../valueObject/messageId.ts"
import type { TimestampMs } from "../valueObject/timestampMs.ts"
import { newTimestampMs } from "../valueObject/timestampMs.ts"
import { isRecord } from "../valueObject/util.ts"
import type { StatusBarTone } from "./tone.ts"

const TOKEN_RATE_ERROR_TPS = 20
const TOKEN_RATE_WARNING_TPS = 40
const TOKEN_RATE_FLYING_TPS = 80
const LATENCY_ERROR_MS = 10_000
const LATENCY_WARNING_MS = 3_000
const LATENCY_FLYING_MS = 1_500
const RESPONSE_WINDOW_MS = 5 * 60_000
const RESPONSE_WINDOW_SIZE = 18
const HEALTH_MIN_RESPONSES = 3

// Five ranks, readable as the gradient of the numbers they lead: flying
// (blue) over healthy (green) over regular (grey) over sluggish (yellow)
// over slow (red). The verdict copies the numbers' colors: it takes the one
// color all numbers share, or grey when they disagree — not a problem, just
// not good.
export type ResponseHealthLevel =
  | "flying"
  | "healthy"
  | "regular"
  | "sluggish"
  | "slow"

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
  medianFirstActivityLatencyMs: number | undefined
  medianFirstTextLatencyMs: number | undefined
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
  if (tokensPerSecond >= TOKEN_RATE_FLYING_TPS) return "info"
  return "good"
}

function resolveLatencyTone(latencyMs: number): StatusBarTone {
  if (latencyMs > LATENCY_ERROR_MS) return "error"
  if (latencyMs > LATENCY_WARNING_MS) return "warning"
  if (latencyMs <= LATENCY_FLYING_MS) return "info"
  return "good"
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

// The middle of the window's latencies, not its mean: one 40-second stall
// drags a mean past the truth, while the median keeps reporting the
// response the provider actually delivers most of the time.
function medianLatencyMs(
  responseTimings: readonly ResponseTiming[],
  readStartMs: (timing: GenerationPartTiming) => TimestampMs | undefined,
): number | undefined {
  const latenciesMs = responseTimings
    .flatMap(({ message, timing }) => {
      const latencyMs = latencySinceMessageStart(message, readStartMs(timing))
      return latencyMs === undefined ? [] : [latencyMs]
    })
    .toSorted((first, second) => first - second)
  if (latenciesMs.length === 0) return undefined
  const middle = Math.floor(latenciesMs.length / 2)
  if (latenciesMs.length % 2 === 1) return latenciesMs[middle]
  return (latenciesMs[middle - 1] + latenciesMs[middle]) / 2
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

// One tone source for the numbers and the verdict, so the verdict can
// never disagree with the colors it leads: the rate gets its tone from the
// pooled average, the waits from the start median that paints them.
function displayTones(readings: {
  averageTokensPerSecond: number
  medianFirstActivityLatencyMs: number | undefined
  medianFirstTextLatencyMs: number | undefined
}): { rate: StatusBarTone; waits: StatusBarTone | undefined } {
  const toneStartMs =
    readings.medianFirstActivityLatencyMs ?? readings.medianFirstTextLatencyMs
  return {
    rate: resolveTokenRateTone(readings.averageTokensPerSecond),
    waits:
      toneStartMs === undefined ? undefined : resolveLatencyTone(toneStartMs),
  }
}

// A verdict needs a streak to read: fewer than HEALTH_MIN_RESPONSES
// completed responses in the window say nothing about the provider's habit.
// The verdict copies the numbers' colors: the shared color wins, any red
// makes it `slow`, and a mix that agrees on nothing stays grey `regular`.
function resolveHealthLevel(
  tones: { rate: StatusBarTone; waits: StatusBarTone | undefined },
  responseCount: number,
): ResponseHealthLevel | undefined {
  if (responseCount < HEALTH_MIN_RESPONSES) return undefined
  const numberTones: StatusBarTone[] =
    tones.waits === undefined ? [tones.rate] : [tones.rate, tones.waits]
  if (numberTones.includes("error")) return "slow"
  if (numberTones.every((tone) => tone === "info")) return "flying"
  if (numberTones.every((tone) => tone === "info" || tone === "good"))
    return "healthy"
  if (numberTones.every((tone) => tone === "warning")) return "sluggish"
  return "regular"
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

  const medianFirstActivityLatencyMs = medianLatencyMs(
    responseTimings,
    (timing) => timing.firstActivityStartMs,
  )
  const medianFirstTextLatencyMs = medianLatencyMs(
    responseTimings,
    (timing) => timing.firstTextStartMs,
  )
  return {
    healthLevel: resolveHealthLevel(
      displayTones({
        averageTokensPerSecond,
        medianFirstActivityLatencyMs,
        medianFirstTextLatencyMs,
      }),
      responseTimings.length,
    ),
    averageTokensPerSecond,
    averageGenerationTokensPerSecond,
    includesReasoning: totalReasoningTokens > 0,
    medianFirstActivityLatencyMs,
    medianFirstTextLatencyMs,
  }
}

const HEALTH_SEGMENT_TONES: Record<ResponseHealthLevel, StatusBarTone> = {
  flying: "info",
  healthy: "good",
  regular: "muted",
  sluggish: "warning",
  slow: "error",
}

function healthSegment(
  level: ResponseHealthLevel | undefined,
): ResponseUsageSegment | undefined {
  if (level === undefined) return undefined
  return { value: level, tone: HEALTH_SEGMENT_TONES[level] }
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

  const activityMs = status.medianFirstActivityLatencyMs
  const textMs = status.medianFirstTextLatencyMs
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
  const tones = displayTones(status)
  const rateSegment: ResponseUsageSegment = {
    value: rateValue,
    tone: tones.rate,
    suffix: " tok/s",
  }
  if (bracketed) {
    rateSegment.prefix = "("
    rateSegment.separator = " "
  }
  segments.push(rateSegment)

  if (waitsMs.length === 0) return segments
  waitsMs.forEach((waitMs, index) => {
    const segment: ResponseUsageSegment = {
      value: formatDuration(waitMs),
      tone: tones.waits ?? "muted",
      separator: index === 0 ? " ~ " : "/",
    }
    if (bracketed && index === waitsMs.length - 1) segment.suffix = ")"
    segments.push(segment)
  })
  return segments
}
