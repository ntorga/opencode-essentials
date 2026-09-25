import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { MessageId } from "../valueObject/messageId.ts"
import { formatResponseStatus, resolveResponseStatus } from "./usageStatus.ts"

const NOW_MS = 1_757_000_600_000

type ResponsePlacement = {
  id: string
  completedAgoMs: number
  durationMs?: number
  outputTokens?: number
  reasoningTokens?: number
  summary?: boolean
  unfinished?: boolean
}

function createAssistantMessage(response: ResponsePlacement) {
  const completedAtMs = NOW_MS - response.completedAgoMs
  const createdMs = completedAtMs - (response.durationMs ?? 5_000)
  return {
    id: response.id,
    role: "assistant",
    ...(response.summary ? { summary: true } : {}),
    time: {
      created: createdMs,
      ...(response.unfinished ? {} : { completed: completedAtMs }),
    },
    tokens: {
      input: 100,
      output: response.outputTokens ?? 25,
      reasoning: response.reasoningTokens ?? 0,
      cache: { read: 20, write: 2 },
    },
    cost: 0.0025,
  }
}

// Offsets are expressed against the message's own created time so a test can
// state a latency directly (textStartMs: 2_000 means the model began visible
// text two seconds after the assistant message was created).
function createPartReader(
  response: ResponsePlacement,
  timing: {
    textStartMs?: number
    textEndMs?: number
    reasoningStartMs?: number
    reasoningEndMs?: number
    toolStartMs?: number
    toolEndMs?: number
  },
): (messageId: MessageId) => readonly unknown[] {
  const completedAtMs = NOW_MS - response.completedAgoMs
  const createdMs = completedAtMs - (response.durationMs ?? 5_000)
  const parts: unknown[] = []
  if (timing.reasoningStartMs !== undefined) {
    parts.push({
      type: "reasoning",
      time: {
        start: createdMs + timing.reasoningStartMs,
        ...(timing.reasoningEndMs === undefined
          ? {}
          : { end: createdMs + timing.reasoningEndMs }),
      },
    })
  }
  if (timing.textStartMs !== undefined) {
    parts.push({
      type: "text",
      time: {
        start: createdMs + timing.textStartMs,
        ...(timing.textEndMs === undefined
          ? {}
          : { end: createdMs + timing.textEndMs }),
      },
    })
  }
  if (timing.toolStartMs !== undefined && timing.toolEndMs !== undefined) {
    parts.push({
      type: "tool",
      state: {
        status: "completed",
        time: {
          start: createdMs + timing.toolStartMs,
          end: createdMs + timing.toolEndMs,
        },
      },
    })
  }
  return (messageId: MessageId) => (messageId === response.id ? parts : [])
}

function mergePartReaders(
  readers: readonly ((messageId: MessageId) => readonly unknown[])[],
): (messageId: MessageId) => readonly unknown[] {
  return (messageId: MessageId) => {
    for (const reader of readers) {
      const parts = reader(messageId)
      if (parts.length > 0) return parts
    }
    return []
  }
}

describe("resolveResponseStatus", () => {
  it("averages both latencies across the response window", () => {
    const fast = {
      id: "msg_fast",
      completedAgoMs: 20_000,
      durationMs: 10_000,
      outputTokens: 200,
    }
    const slower = {
      id: "msg_slower",
      completedAgoMs: 40_000,
      durationMs: 10_000,
      outputTokens: 200,
    }
    const status = resolveResponseStatus(
      [fast, slower].map(createAssistantMessage),
      mergePartReaders([
        createPartReader(fast, { textStartMs: 2_000 }),
        createPartReader(slower, { textStartMs: 4_000 }),
      ]),
      NOW_MS,
    )

    assert.deepEqual(status, {
      healthLevel: undefined,
      averageTokensPerSecond: 20,
      averageGenerationTokensPerSecond: 20,
      includesReasoning: false,
      averageFirstActivityLatencyMs: 3_000,
      averageFirstTextLatencyMs: 3_000,
    })
    assert.ok(status)
    assert.deepEqual(formatResponseStatus(status), [
      { value: "20", tone: "warning", suffix: " tok/s" },
      { value: "3.0", tone: "muted", separator: " ~ ", suffix: "s" },
    ])
  })

  it("subtracts tool execution from the generation window", () => {
    const response: ResponsePlacement = {
      id: "msg_toolheavy",
      completedAgoMs: 60_000,
      durationMs: 120_000,
      outputTokens: 900,
    }
    const status = resolveResponseStatus(
      [createAssistantMessage(response)],
      createPartReader(response, {
        textStartMs: 2_000,
        textEndMs: 20_000,
        toolStartMs: 20_000,
        toolEndMs: 110_000,
      }),
      NOW_MS,
    )

    assert.equal(status?.averageTokensPerSecond, 50)
    assert.equal(status?.averageFirstActivityLatencyMs, 2_000)
  })

  it("keeps argument gaps and drops tool runs across bursts", () => {
    const response: ResponsePlacement = {
      id: "msg_two_bursts",
      completedAgoMs: 90_000,
      durationMs: 60_000,
      outputTokens: 300,
    }
    const createdMs = NOW_MS - 150_000
    const status = resolveResponseStatus(
      [createAssistantMessage(response)],
      () => [
        {
          type: "text",
          time: { start: createdMs + 1_000, end: createdMs + 6_000 },
        },
        {
          type: "tool",
          state: {
            status: "completed",
            time: { start: createdMs + 6_000, end: createdMs + 50_000 },
          },
        },
        {
          type: "text",
          synthetic: true,
          time: { start: createdMs + 7_000, end: createdMs + 9_000 },
        },
        {
          type: "text",
          time: { start: createdMs + 51_000, end: createdMs + 56_000 },
        },
      ],
      NOW_MS,
    )

    assert.equal(status?.averageTokensPerSecond, 300 / 11)
  })

  it("falls back to the message lifetime when no text part has an end", () => {
    const response: ResponsePlacement = {
      id: "msg_open",
      completedAgoMs: 10_000,
      durationMs: 5_000,
      outputTokens: 25,
    }
    const status = resolveResponseStatus(
      [createAssistantMessage(response)],
      createPartReader(response, { textStartMs: 500 }),
      NOW_MS,
    )

    assert.equal(status?.averageTokensPerSecond, 5)
  })

  it("reports no metrics when the window has no completed responses", () => {
    const stale: ResponsePlacement = {
      id: "msg_stale",
      completedAgoMs: 6 * 60_000,
      outputTokens: 500,
    }
    const streaming: ResponsePlacement = {
      id: "msg_streaming",
      completedAgoMs: 0,
      unfinished: true,
      outputTokens: 500,
    }
    const status = resolveResponseStatus(
      [createAssistantMessage(stale), createAssistantMessage(streaming)],
      () => [],
      NOW_MS,
    )

    assert.equal(status, undefined)
  })

  it("ignores summary and empty-output messages", () => {
    const status = resolveResponseStatus(
      [
        createAssistantMessage({
          id: "msg_summary",
          completedAgoMs: 10_000,
          outputTokens: 500,
          summary: true,
        }),
        createAssistantMessage({
          id: "msg_empty",
          completedAgoMs: 20_000,
          outputTokens: 0,
        }),
      ],
      () => [],
      NOW_MS,
    )

    assert.equal(status, undefined)
  })

  it("tones a rate under the error bar as error and under warning as warning", () => {
    const warning: ResponsePlacement = {
      id: "msg_warning",
      completedAgoMs: 10_000,
      durationMs: 10_000,
      outputTokens: 300,
    }
    const error: ResponsePlacement = {
      id: "msg_error",
      completedAgoMs: 10_000,
      durationMs: 10_000,
      outputTokens: 100,
    }
    const warningStatus = resolveResponseStatus(
      [createAssistantMessage(warning)],
      () => [],
      NOW_MS,
    )
    const errorStatus = resolveResponseStatus(
      [createAssistantMessage(error)],
      () => [],
      NOW_MS,
    )

    assert.ok(warningStatus)
    assert.ok(errorStatus)
    assert.equal(formatResponseStatus(warningStatus)[0]?.tone, "warning")
    assert.equal(formatResponseStatus(errorStatus)[0]?.tone, "error")
  })

  it("takes the latency-group tone from the start wait", () => {
    const slowStart: ResponsePlacement = {
      id: "msg_slowstart",
      completedAgoMs: 10_000,
      durationMs: 20_000,
      outputTokens: 1_000,
    }
    const status = resolveResponseStatus(
      [createAssistantMessage(slowStart)],
      createPartReader(slowStart, { textStartMs: 4_000 }),
      NOW_MS,
    )

    assert.ok(status)
    assert.equal(status.averageFirstActivityLatencyMs, 4_000)
    assert.equal(formatResponseStatus(status)[1]?.tone, "warning")
  })

  it("omits first-text latency when text timing is missing or invalid", () => {
    const response: ResponsePlacement = {
      id: "msg_notext",
      completedAgoMs: 10_000,
      durationMs: 5_000,
      outputTokens: 25,
    }
    const createdMs = NOW_MS - 15_000
    const status = resolveResponseStatus(
      [createAssistantMessage(response)],
      () => [
        { type: "text", time: { start: createdMs - 1_000 } },
        { type: "text", time: { start: 1_757_000_000 } },
      ],
      NOW_MS,
    )

    assert.ok(status)
    assert.equal(status.averageFirstTextLatencyMs, undefined)
    assert.equal(status.averageFirstActivityLatencyMs, undefined)
    assert.equal(status.averageTokensPerSecond, 5)
    assert.deepEqual(formatResponseStatus(status), [
      { value: "5", tone: "error", suffix: " tok/s" },
    ])
  })

  it("pairs the thinking-inclusive rate over the same active window", () => {
    const response: ResponsePlacement = {
      id: "msg_reasoning",
      completedAgoMs: 90_000,
      durationMs: 60_000,
      outputTokens: 300,
      reasoningTokens: 600,
    }
    const status = resolveResponseStatus(
      [createAssistantMessage(response)],
      createPartReader(response, {
        reasoningStartMs: 0,
        reasoningEndMs: 4_000,
        textStartMs: 4_000,
        textEndMs: 10_000,
      }),
      NOW_MS,
    )

    assert.ok(status)
    assert.equal(status.averageTokensPerSecond, 30)
    assert.equal(status.averageGenerationTokensPerSecond, 90)
    assert.equal(status.includesReasoning, true)
    assert.equal(formatResponseStatus(status)[0]?.value, "30/90")
  })

  it("collapses the pair when both rates round to the same number", () => {
    const response: ResponsePlacement = {
      id: "msg_equal_rates",
      completedAgoMs: 90_000,
      durationMs: 60_000,
      outputTokens: 300,
      reasoningTokens: 4,
    }
    const status = resolveResponseStatus(
      [createAssistantMessage(response)],
      createPartReader(response, {
        reasoningStartMs: 0,
        reasoningEndMs: 1_200,
        textStartMs: 4_000,
        textEndMs: 10_000,
      }),
      NOW_MS,
    )

    assert.ok(status)
    assert.equal(formatResponseStatus(status)[0]?.value, "30")
  })

  it("grades the window verdict from response shares", () => {
    const placements: ResponsePlacement[] = [
      {
        id: "msg_healthy_one",
        completedAgoMs: 10_000,
        durationMs: 10_000,
        outputTokens: 500,
      },
      {
        id: "msg_healthy_two",
        completedAgoMs: 20_000,
        durationMs: 10_000,
        outputTokens: 500,
      },
      {
        id: "msg_healthy_three",
        completedAgoMs: 30_000,
        durationMs: 10_000,
        outputTokens: 500,
      },
    ]
    const healthy = resolveResponseStatus(
      placements.map(createAssistantMessage),
      () => [],
      NOW_MS,
    )
    assert.equal(healthy?.healthLevel, "healthy")

    const troubled: ResponsePlacement[] = [
      {
        id: "msg_troubled",
        completedAgoMs: 10_000,
        durationMs: 10_000,
        outputTokens: 300,
      },
    ]
    const troubledShare = resolveResponseStatus(
      [
        placements[0],
        ...troubled,
        {
          id: "msg_troubled_two",
          completedAgoMs: 15_000,
          durationMs: 10_000,
          outputTokens: 300,
        },
      ].map(createAssistantMessage),
      () => [],
      NOW_MS,
    )
    assert.equal(troubledShare?.healthLevel, "regular")

    const poor: ResponsePlacement[] = [
      {
        id: "msg_poor",
        completedAgoMs: 10_000,
        durationMs: 10_000,
        outputTokens: 100,
      },
    ]
    const lonePoor = resolveResponseStatus(
      [...placements.slice(0, 2), ...poor].map(createAssistantMessage),
      () => [],
      NOW_MS,
    )
    assert.equal(lonePoor?.healthLevel, "regular")
    const sluggish = resolveResponseStatus(
      [
        ...placements,
        ...poor,
        {
          id: "msg_poor_two",
          completedAgoMs: 15_000,
          durationMs: 10_000,
          outputTokens: 100,
        },
      ].map(createAssistantMessage),
      () => [],
      NOW_MS,
    )
    assert.equal(sluggish?.healthLevel, "sluggish")

    const slow = resolveResponseStatus(
      [
        ...poor,
        {
          id: "msg_poor_two",
          completedAgoMs: 15_000,
          durationMs: 10_000,
          outputTokens: 100,
        },
        {
          id: "msg_poor_three",
          completedAgoMs: 20_000,
          durationMs: 10_000,
          outputTokens: 100,
        },
        placements[0],
      ].map(createAssistantMessage),
      () => [],
      NOW_MS,
    )
    assert.equal(slow?.healthLevel, "slow")
  })

  it("earns flying when every response is good and the averages are fast", () => {
    const fastResponses = [1, 2, 3].map((index) => ({
      id: `msg_flying_${index}`,
      completedAgoMs: index * 10_000,
      durationMs: 10_000,
      outputTokens: 900,
    }))
    const status = resolveResponseStatus(
      fastResponses.map(createAssistantMessage),
      mergePartReaders(
        fastResponses.map((response) =>
          createPartReader(response, {
            textStartMs: 800,
            textEndMs: 10_000,
          }),
        ),
      ),
      NOW_MS,
    )

    assert.equal(status?.healthLevel, "flying")
  })

  it("keeps fast-but-not-flying averages at healthy", () => {
    const steadyResponses = [1, 2, 3].map((index) => ({
      id: `msg_steady_${index}`,
      completedAgoMs: index * 10_000,
      durationMs: 10_000,
      outputTokens: 900,
    }))
    const status = resolveResponseStatus(
      steadyResponses.map(createAssistantMessage),
      mergePartReaders(
        steadyResponses.map((response) =>
          createPartReader(response, {
            textStartMs: 2_500,
            textEndMs: 10_000,
          }),
        ),
      ),
      NOW_MS,
    )

    assert.equal(status?.healthLevel, "healthy")
  })

  it("holds the verdict off until three responses are in the window", () => {
    const placements: ResponsePlacement[] = [
      {
        id: "msg_pair_one",
        completedAgoMs: 10_000,
        durationMs: 10_000,
        outputTokens: 500,
      },
      {
        id: "msg_pair_two",
        completedAgoMs: 20_000,
        durationMs: 10_000,
        outputTokens: 500,
      },
    ]
    const status = resolveResponseStatus(
      placements.map(createAssistantMessage),
      () => [],
      NOW_MS,
    )

    assert.equal(status?.healthLevel, undefined)
    assert.equal(status?.averageTokensPerSecond, 50)
  })

  it("grades a slow response start as troubled", () => {
    const slowStartId = "msg_slow_c"
    const slowStartAgoMs = 30_000
    const slowStartCreatedMs = NOW_MS - slowStartAgoMs - 10_000
    const placements: ResponsePlacement[] = [
      {
        id: "msg_slow_a",
        completedAgoMs: 10_000,
        durationMs: 10_000,
        outputTokens: 500,
      },
      {
        id: "msg_slow_b",
        completedAgoMs: 20_000,
        durationMs: 10_000,
        outputTokens: 500,
      },
      {
        id: slowStartId,
        completedAgoMs: slowStartAgoMs,
        durationMs: 10_000,
        outputTokens: 500,
      },
    ]
    const status = resolveResponseStatus(
      placements.map(createAssistantMessage),
      (messageId) =>
        messageId === slowStartId
          ? [{ type: "text", time: { start: slowStartCreatedMs + 4_000 } }]
          : [],
      NOW_MS,
    )

    assert.equal(status?.healthLevel, "regular")
  })

  it("cuts the window at five minutes", () => {
    const fastRecent: ResponsePlacement[] = [
      {
        id: "msg_recent_one",
        completedAgoMs: 10_000,
        durationMs: 10_000,
        outputTokens: 500,
      },
      {
        id: "msg_recent_two",
        completedAgoMs: 20_000,
        durationMs: 10_000,
        outputTokens: 500,
      },
      {
        id: "msg_recent_three",
        completedAgoMs: 30_000,
        durationMs: 10_000,
        outputTokens: 500,
      },
    ]
    const poorStale: ResponsePlacement[] = [
      {
        id: "msg_stale_one",
        completedAgoMs: 6 * 60_000,
        durationMs: 10_000,
        outputTokens: 100,
      },
    ]
    const status = resolveResponseStatus(
      [...fastRecent, ...poorStale].map(createAssistantMessage),
      () => [],
      NOW_MS,
    )

    assert.equal(status?.healthLevel, "healthy")
    assert.equal(status?.averageTokensPerSecond, 50)
  })

  it("caps the window at eighteen responses", () => {
    const poorRecent: ResponsePlacement[] = []
    for (let index = 0; index < 18; index += 1) {
      poorRecent.push({
        id: `msg_poor_${index}`,
        completedAgoMs: 10_000 + index * 5_000,
        durationMs: 10_000,
        outputTokens: 100,
      })
    }
    const fastOlder: ResponsePlacement[] = [
      {
        id: "msg_fast_older_one",
        completedAgoMs: 250_000,
        durationMs: 10_000,
        outputTokens: 10_000,
      },
      {
        id: "msg_fast_older_two",
        completedAgoMs: 260_000,
        durationMs: 10_000,
        outputTokens: 10_000,
      },
    ]
    const status = resolveResponseStatus(
      [...poorRecent, ...fastOlder].map(createAssistantMessage),
      () => [],
      NOW_MS,
    )

    assert.equal(status?.averageTokensPerSecond, 10)
    assert.equal(status?.healthLevel, "slow")
  })
})

describe("formatResponseStatus", () => {
  it("paints every rank of the ladder with its own tone", () => {
    const ladder = [
      ["flying", "info"],
      ["healthy", "good"],
      ["regular", "muted"],
      ["sluggish", "warning"],
      ["slow", "error"],
    ] as const
    for (const [level, tone] of ladder) {
      const [segment] = formatResponseStatus({
        healthLevel: level,
        averageTokensPerSecond: 50,
        averageGenerationTokensPerSecond: 50,
        includesReasoning: false,
        averageFirstActivityLatencyMs: undefined,
        averageFirstTextLatencyMs: undefined,
      })
      assert.deepEqual(segment, { value: level, tone })
    }
  })

  it("brackets the reading when the verdict and the waits share the story", () => {
    const segments = formatResponseStatus({
      healthLevel: "healthy",
      averageTokensPerSecond: 62,
      averageGenerationTokensPerSecond: 118,
      includesReasoning: true,
      averageFirstActivityLatencyMs: 400,
      averageFirstTextLatencyMs: 11_300,
    })

    assert.deepEqual(segments, [
      { value: "healthy", tone: "good" },
      {
        value: "62/118",
        tone: "muted",
        prefix: "(",
        suffix: " tok/s",
        separator: " ",
      },
      {
        value: "400",
        tone: "muted",
        suffix: "ms",
        separator: " ~ ",
      },
      {
        value: "11.3",
        tone: "muted",
        suffix: "s)",
        separator: "/",
      },
    ])
  })

  it("drops the brackets and joins with the standard separator without a verdict", () => {
    const segments = formatResponseStatus({
      healthLevel: undefined,
      averageTokensPerSecond: 62,
      averageGenerationTokensPerSecond: 62,
      includesReasoning: false,
      averageFirstActivityLatencyMs: 400,
      averageFirstTextLatencyMs: undefined,
    })

    assert.deepEqual(segments, [
      { value: "62", tone: "muted", suffix: " tok/s" },
      { value: "400", tone: "muted", separator: " ~ ", suffix: "ms" },
    ])
  })

  it("leaves the waits out when no part timing survived validation", () => {
    const segments = formatResponseStatus({
      healthLevel: "sluggish",
      averageTokensPerSecond: 30,
      averageGenerationTokensPerSecond: 30,
      includesReasoning: false,
      averageFirstActivityLatencyMs: undefined,
      averageFirstTextLatencyMs: undefined,
    })

    assert.deepEqual(segments, [
      { value: "sluggish", tone: "warning" },
      { value: "30", tone: "warning", suffix: " tok/s" },
    ])
  })
})
