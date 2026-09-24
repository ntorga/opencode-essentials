import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  formatResponseUsageStatus,
  resolveResponseUsageStatus,
} from "./usageStatus.ts"

const RESPONSE_STARTED_AT = 1_757_000_000_000

function createAssistantMessage(
  input: {
    id?: string
    createdAfterMs?: number
    completedAfterMs?: number
    outputTokens?: number
    reasoningTokens?: number
    summary?: boolean
  } = {},
) {
  return {
    id: input.id ?? "msg_assistant",
    role: "assistant",
    ...(input.summary ? { summary: true } : {}),
    time: {
      created: RESPONSE_STARTED_AT + (input.createdAfterMs ?? 0),
      completed: RESPONSE_STARTED_AT + (input.completedAfterMs ?? 5_000),
    },
    tokens: {
      input: 100,
      output: input.outputTokens ?? 25,
      reasoning: input.reasoningTokens ?? 0,
      cache: { read: 20, write: 2 },
    },
    cost: 0.0025,
  }
}

describe("resolveResponseUsageStatus", () => {
  it("averages both latencies across the token-rate window", () => {
    const usage = resolveResponseUsageStatus(
      [
        createAssistantMessage({
          id: "msg_latest",
          createdAfterMs: 20_000,
          completedAfterMs: 30_000,
          outputTokens: 10,
        }),
        createAssistantMessage({
          id: "msg_oldest",
          completedAfterMs: 1_000,
          outputTokens: 1_000,
        }),
        createAssistantMessage({
          id: "msg_middle",
          createdAfterMs: 10_000,
          completedAfterMs: 15_000,
          outputTokens: 10,
        }),
        createAssistantMessage({
          id: "msg_recent",
          createdAfterMs: 2_000,
          completedAfterMs: 4_000,
          outputTokens: 40,
        }),
      ],
      (messageId) => {
        if (messageId === "msg_latest") {
          return [
            { type: "text", time: { start: RESPONSE_STARTED_AT + 20_650 } },
          ]
        }
        if (messageId === "msg_recent") {
          return [
            { type: "text", time: { start: RESPONSE_STARTED_AT + 2_200 } },
          ]
        }
        return []
      },
    )

    assert.ok(usage)
    assert.deepEqual(usage, {
      averageTokensPerSecond: 60 / 17,
      averageGenerationTokensPerSecond: 60 / 17,
      includesReasoning: false,
      averageFirstActivityLatencyMs: 425,
      averageFirstTextLatencyMs: 425,
      averageResponseDurationMs: 17_000 / 3,
    })
    assert.deepEqual(formatResponseUsageStatus(usage), [
      { value: "4", tone: "error", suffix: " tok/s" },
      { value: "425ms/5.7s", tone: "muted", prefix: "latency: " },
    ])
  })

  it("subtracts tool execution from the generation window", () => {
    const usage = resolveResponseUsageStatus(
      [
        createAssistantMessage({
          id: "msg_toolheavy",
          completedAfterMs: 120_000,
          outputTokens: 900,
        }),
      ],
      () => [
        {
          type: "text",
          time: {
            start: RESPONSE_STARTED_AT + 2_000,
            end: RESPONSE_STARTED_AT + 20_000,
          },
        },
        {
          type: "tool",
          state: {
            status: "completed",
            time: {
              start: RESPONSE_STARTED_AT + 20_000,
              end: RESPONSE_STARTED_AT + 110_000,
            },
          },
        },
      ],
    )

    assert.ok(usage)
    assert.equal(usage.averageTokensPerSecond, 50)
    assert.equal(usage.averageResponseDurationMs, 120_000)
    assert.deepEqual(formatResponseUsageStatus(usage)[0], {
      value: "50",
      tone: "muted",
      suffix: " tok/s",
    })
  })

  it("keeps argument gaps and drops tool runs across bursts", () => {
    const usage = resolveResponseUsageStatus(
      [
        createAssistantMessage({
          id: "msg_two_bursts",
          completedAfterMs: 60_000,
          outputTokens: 300,
        }),
      ],
      () => [
        {
          type: "text",
          time: {
            start: RESPONSE_STARTED_AT + 1_000,
            end: RESPONSE_STARTED_AT + 6_000,
          },
        },
        {
          type: "tool",
          state: {
            status: "completed",
            time: {
              start: RESPONSE_STARTED_AT + 6_000,
              end: RESPONSE_STARTED_AT + 50_000,
            },
          },
        },
        {
          type: "text",
          synthetic: true,
          time: {
            start: RESPONSE_STARTED_AT + 7_000,
            end: RESPONSE_STARTED_AT + 9_000,
          },
        },
        {
          type: "text",
          time: {
            start: RESPONSE_STARTED_AT + 51_000,
            end: RESPONSE_STARTED_AT + 56_000,
          },
        },
      ],
    )

    assert.equal(usage?.averageTokensPerSecond, 300 / 11)
  })

  it("falls back to the message lifetime when no text part has an end", () => {
    const usage = resolveResponseUsageStatus(
      [createAssistantMessage({ completedAfterMs: 5_000, outputTokens: 25 })],
      () => [{ type: "text", time: { start: RESPONSE_STARTED_AT + 500 } }],
    )

    assert.equal(usage?.averageTokensPerSecond, 5)
  })

  it("tones slow token rates as warning or error", () => {
    const warning = resolveResponseUsageStatus(
      [createAssistantMessage({ completedAfterMs: 1_000, outputTokens: 30 })],
      () => [],
    )
    const error = resolveResponseUsageStatus(
      [createAssistantMessage({ completedAfterMs: 1_000, outputTokens: 10 })],
      () => [],
    )
    assert.ok(warning)
    assert.ok(error)

    assert.equal(formatResponseUsageStatus(warning)[0].tone, "warning")
    assert.equal(formatResponseUsageStatus(error)[0].tone, "error")
  })

  it("tones slow first-text latency as warning or error", () => {
    const warning = resolveResponseUsageStatus(
      [createAssistantMessage({ completedAfterMs: 20_000 })],
      () => [{ type: "text", time: { start: RESPONSE_STARTED_AT + 5_000 } }],
    )
    const error = resolveResponseUsageStatus(
      [createAssistantMessage({ completedAfterMs: 20_000 })],
      () => [{ type: "text", time: { start: RESPONSE_STARTED_AT + 15_000 } }],
    )
    assert.ok(warning)
    assert.ok(error)

    assert.equal(formatResponseUsageStatus(warning)[1]?.tone, "warning")
    assert.equal(formatResponseUsageStatus(error)[1]?.tone, "error")
  })

  it("uses available responses when fewer than three have completed", () => {
    const usage = resolveResponseUsageStatus(
      [
        createAssistantMessage({
          id: "msg_earlier",
          completedAfterMs: 2_000,
          outputTokens: 20,
        }),
        createAssistantMessage({
          id: "msg_latest",
          createdAfterMs: 10_000,
          completedAfterMs: 15_000,
          outputTokens: 40,
        }),
      ],
      () => [],
    )

    assert.deepEqual(usage, {
      averageTokensPerSecond: 60 / 7,
      averageGenerationTokensPerSecond: 60 / 7,
      includesReasoning: false,
      averageFirstActivityLatencyMs: undefined,
      averageFirstTextLatencyMs: undefined,
      averageResponseDurationMs: 3_500,
    })
  })

  it("ignores summary, unfinished, and empty-output messages", () => {
    const usage = resolveResponseUsageStatus(
      [
        createAssistantMessage({ summary: true }),
        {
          ...createAssistantMessage({ id: "msg_streaming" }),
          time: { created: RESPONSE_STARTED_AT },
        },
        createAssistantMessage({ id: "msg_empty", outputTokens: 0 }),
      ],
      () => [],
    )

    assert.equal(usage, undefined)
  })

  it("omits first-text timing when text timing is absent or invalid", () => {
    const usage = resolveResponseUsageStatus([createAssistantMessage()], () => [
      { type: "text", time: { start: RESPONSE_STARTED_AT - 1 } },
      { type: "text", time: { start: 1_757_000_000 } },
      { type: "text", time: { start: RESPONSE_STARTED_AT + 6_000 } },
    ])

    assert.ok(usage)
    assert.equal(usage.averageFirstTextLatencyMs, undefined)
    assert.equal(usage.averageTokensPerSecond, 5)
    assert.deepEqual(formatResponseUsageStatus(usage), [
      { value: "5", tone: "error", suffix: " tok/s" },
      { value: "5.0s", tone: "muted", prefix: "latency: " },
    ])
  })

  it("rejects a malformed output token count", () => {
    const malformedMessage = {
      ...createAssistantMessage(),
      tokens: {
        output: Number.NaN,
      },
    }

    assert.equal(
      resolveResponseUsageStatus([malformedMessage], () => []),
      undefined,
    )
  })

  it("does not need input or cache counts for the response footer", () => {
    const message = {
      ...createAssistantMessage(),
      tokens: { output: 25 },
    }

    const usage = resolveResponseUsageStatus([message], () => [])

    assert.equal(usage?.averageTokensPerSecond, 5)
  })

  it("formats token rate and labels both latency values", () => {
    const usage = resolveResponseUsageStatus([createAssistantMessage()], () => [
      { type: "text", time: { start: RESPONSE_STARTED_AT + 650 } },
    ])
    assert.ok(usage)
    assert.deepEqual(formatResponseUsageStatus(usage), [
      { value: "5", tone: "error", suffix: " tok/s" },
      { value: "650ms/5.0s", tone: "muted", prefix: "latency: " },
    ])
  })

  it("reports thinking-inclusive throughput when the model emits reasoning", () => {
    const usage = resolveResponseUsageStatus(
      [
        createAssistantMessage({
          id: "msg_reasoning",
          completedAfterMs: 60_000,
          outputTokens: 300,
          reasoningTokens: 600,
        }),
      ],
      () => [
        {
          type: "reasoning",
          time: {
            start: RESPONSE_STARTED_AT,
            end: RESPONSE_STARTED_AT + 4_000,
          },
        },
        {
          type: "text",
          time: {
            start: RESPONSE_STARTED_AT + 4_000,
            end: RESPONSE_STARTED_AT + 10_000,
          },
        },
      ],
    )

    assert.ok(usage)
    assert.equal(usage.averageTokensPerSecond, 30)
    assert.equal(usage.averageGenerationTokensPerSecond, 90)
    assert.deepEqual(formatResponseUsageStatus(usage), [
      { value: "30/90", tone: "warning", suffix: " tok/s" },
      { value: "0ms/4.0s/60.0s", tone: "muted", prefix: "latency: " },
    ])
  })

  it("shows one rate when thinking adds no measurable throughput", () => {
    const usage = resolveResponseUsageStatus(
      [
        createAssistantMessage({
          id: "msg_equal_rates",
          completedAfterMs: 60_000,
          outputTokens: 300,
          reasoningTokens: 4,
        }),
      ],
      () => [
        {
          type: "reasoning",
          time: {
            start: RESPONSE_STARTED_AT,
            end: RESPONSE_STARTED_AT + 1_200,
          },
        },
        {
          type: "text",
          time: {
            start: RESPONSE_STARTED_AT + 4_000,
            end: RESPONSE_STARTED_AT + 10_000,
          },
        },
      ],
    )

    assert.ok(usage)
    assert.equal(usage.averageTokensPerSecond, 30)
    assert.equal(usage.averageGenerationTokensPerSecond, 30.4)
    assert.equal(formatResponseUsageStatus(usage)[0]?.value, "30")
  })
})
