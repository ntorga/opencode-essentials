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
    cost?: number
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
    cost: input.cost ?? 0.0025,
  }
}

describe("resolveResponseUsageStatus", () => {
  it("measures the newest completed answer", () => {
    const usage = resolveResponseUsageStatus(
      [
        createAssistantMessage({ completedAfterMs: 2_000 }),
        createAssistantMessage({
          id: "msg_newest",
          createdAfterMs: 10_000,
          completedAfterMs: 15_000,
          outputTokens: 40,
        }),
      ],
      (messageId) =>
        messageId === "msg_newest"
          ? [{ type: "text", time: { start: RESPONSE_STARTED_AT + 10_650 } }]
          : [],
    )

    assert.deepEqual(usage, {
      outputTokens: 40,
      tokensPerSecond: 8,
      firstTextMs: 650,
      responseDurationMs: 5_000,
      costUsd: 0.0025,
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

    assert.equal(usage?.firstTextMs, undefined)
    assert.equal(usage?.tokensPerSecond, 5)
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

    assert.equal(usage?.outputTokens, 25)
  })

  it("formats output usage, first-text time, duration, and cost", () => {
    const usage = resolveResponseUsageStatus([createAssistantMessage()], () => [
      { type: "text", time: { start: RESPONSE_STARTED_AT + 650 } },
    ])
    assert.ok(usage)
    assert.equal(
      formatResponseUsageStatus(usage),
      "response · 25 out · 5 tok/s · 650ms first text · 5.0s duration · $0.0025",
    )
  })
})
