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
      reasoning: 5,
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
      averageFirstTextLatencyMs: 425,
      averageResponseDurationMs: 17_000 / 3,
    })
    assert.equal(
      formatResponseUsageStatus(usage),
      "4 tok/s · first text latency: 425ms | total: 5.7s",
    )
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
    ])

    assert.ok(usage)
    assert.equal(usage.averageFirstTextLatencyMs, undefined)
    assert.equal(usage.averageTokensPerSecond, 5)
    assert.equal(
      formatResponseUsageStatus(usage),
      "5 tok/s · total latency: 5.0s",
    )
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
    assert.equal(
      formatResponseUsageStatus(usage),
      "5 tok/s · first text latency: 650ms | total: 5.0s",
    )
  })
})
