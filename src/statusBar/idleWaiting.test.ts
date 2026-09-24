import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveIdleClockLine, toIdleClockMessages } from "./idleWaiting.ts"

const T0 = 1_757_000_000_000

function assistant(
  createdOffsetMs: number,
  completedOffsetMs?: number,
  isSummary = false,
) {
  return {
    role: "assistant",
    ...(isSummary ? { summary: true } : {}),
    time: {
      created: T0 + createdOffsetMs,
      ...(completedOffsetMs === undefined
        ? {}
        : { completed: T0 + completedOffsetMs }),
    },
  }
}

function user(createdOffsetMs: number) {
  return { role: "user", time: { created: T0 + createdOffsetMs } }
}

function clockMessages(...raw: unknown[]) {
  return toIdleClockMessages(raw)
}

describe("toIdleClockMessages", () => {
  it("keeps user and assistant entries with their completions", () => {
    const messages = clockMessages(user(10), assistant(20, 30))
    assert.deepEqual(
      messages.map((message) => [
        message.role,
        message.completedAtMs,
        message.isCompactionSummary,
      ]),
      [
        ["user", undefined, false],
        ["assistant", T0 + 30, false],
      ],
    )
  })

  it("flags assistant summary turns", () => {
    const messages = clockMessages(assistant(0, 10, true))
    assert.equal(messages[0]?.isCompactionSummary, true)
  })

  const dropped: unknown[] = [
    null,
    "assistant",
    {},
    { role: "system", time: { created: T0 } },
    { role: "assistant" },
    { role: "assistant", time: "now" },
  ]

  for (const candidate of dropped) {
    it(`drops ${JSON.stringify(candidate)}`, () => {
      const kept = toIdleClockMessages([user(0), candidate, user(5)]).length
      assert.equal(kept, 2)
    })
  }

  it("keeps an entry whose completion number is nonsense as undefined", () => {
    const messages = toIdleClockMessages([
      { role: "assistant", time: { completed: 1_757_000_000 } },
    ])
    assert.equal(
      messages[0]?.completedAtMs,
      undefined,
      "a seconds-epoch completed value is rejected by TimestampMs, not trusted",
    )
  })
})

describe("resolveIdleClockLine", () => {
  const settled = () => clockMessages(user(0), assistant(10, 20))
  const compactor = { enabled: true, idleTimeoutMs: 10 * 60_000 }

  for (const status of ["busy", "retry"] as const) {
    it(`hides while ${String(status)}`, () => {
      const line = resolveIdleClockLine(
        status,
        settled(),
        T0 + 5_000,
        compactor,
      )
      assert.equal(line, undefined)
    })
  }

  it("shows while a reopened session has no status entry", () => {
    const line = resolveIdleClockLine(
      undefined,
      settled(),
      T0 + 5_000,
      compactor,
    )
    assert.ok(line)
    assert.equal(line.color, "muted")
    assert.match(line.text, /^idle: \d+s \| since /)
  })

  it("hides when nothing has completed", () => {
    const messages = clockMessages(user(0))
    assert.equal(
      resolveIdleClockLine("idle", messages, T0 + 5_000, compactor),
      undefined,
    )
  })

  it("shows the local start time alone when idle began today", () => {
    const line = resolveIdleClockLine(
      "idle",
      settled(),
      T0 + 320_000,
      compactor,
    )
    assert.deepEqual(line, {
      text: `idle: 5m 19s | since ${new Date(T0 + 20).toLocaleTimeString(
        undefined,
        { timeStyle: "short" },
      )}`,
      color: "warning",
    })
  })

  it("adds the date when idle began on an earlier day", () => {
    const line = resolveIdleClockLine(
      "idle",
      settled(),
      T0 + 26 * 60 * 60_000,
      compactor,
    )
    assert.equal(
      line?.text,
      `idle: 25h 59m | since ${new Date(T0 + 20).toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      })}`,
    )
  })

  it("pads the first minute boundary in the elapsed stamp", () => {
    const line = resolveIdleClockLine("idle", settled(), T0 + 60_020, compactor)
    assert.match(line?.text ?? "", /^idle: 1m 00s \| since /)
  })

  it("does not re-anchor on the compactor's summary turn", () => {
    const messages = clockMessages(
      assistant(0, 100),
      assistant(1_800_000, 1_800_050, true),
    )
    const line = resolveIdleClockLine("idle", messages, T0 + 100_000, compactor)
    assert.match(line?.text ?? "", /^idle: 1m 39s \| since /)
  })

  it("turns red at eighty percent of the compactor timeout", () => {
    const line = resolveIdleClockLine(
      "idle",
      settled(),
      T0 + 8 * 60_000 + 20,
      compactor,
    )
    assert.equal(line?.color, "error")
  })

  it("keeps the counter muted when the idle compactor is disabled", () => {
    const line = resolveIdleClockLine("idle", settled(), T0 + 8 * 60_000 + 20, {
      ...compactor,
      enabled: false,
    })
    assert.equal(line?.color, "muted")
  })

  it("hides a negative elapsed from a clock disagreement", () => {
    const line = resolveIdleClockLine("idle", settled(), T0 - 1, compactor)
    assert.equal(line, undefined)
  })
})
