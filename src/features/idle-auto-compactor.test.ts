import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Event, UserMessage } from "@opencode-ai/sdk"
import {
  resolveEssentialsStatePath,
  writeFeatureEnabled,
  writeGlobalEnabled,
  writeIdleTimeoutMs,
} from "../state.ts"
import type { IdleTimeoutMs } from "../valueObject/idleTimeoutMs.ts"
import { idleAutoCompactorFeature } from "./idle-auto-compactor.ts"

// Note: Setup/teardown are intentionally inline — test independence
// requires each file to own its preconditions, even if it duplicates code.

const SHORT_IDLE_MS = 40
const SHORT_IDLE_TIMEOUT_MS = SHORT_IDLE_MS as IdleTimeoutMs
const OVER_CEILING_TIMEOUT_MS = (2 ** 32) as IdleTimeoutMs
const LONGER_THAN_IDLE_MS = 120

let dataHomeTemp = ""
let previousDataHome: string | undefined

beforeEach(() => {
  previousDataHome = process.env.XDG_DATA_HOME
  dataHomeTemp = mkdtempSync(path.join(tmpdir(), "essentials-test-"))
  process.env.XDG_DATA_HOME = dataHomeTemp
})

afterEach(() => {
  // "" and unset behave the same: resolveEssentialsStatePath falls back to
  // ~/.local/share for both.
  process.env.XDG_DATA_HOME = previousDataHome ?? ""
  rmSync(dataHomeTemp, { recursive: true, force: true })
})

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function sessionStatusEvent(sessionId: string, status: "idle" | "busy"): Event {
  return {
    type: "session.status",
    properties: { sessionID: sessionId, status: { type: status } },
  } as unknown as Event
}

function sessionDeletedEvent(sessionId: string): Event {
  return {
    type: "session.deleted",
    properties: { info: { id: sessionId } },
  } as unknown as Event
}

function userMessage(sessionId: string): UserMessage {
  return {
    id: "msg-test",
    sessionID: sessionId,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "fake", modelID: "fake-model" },
  }
}

function fakeClient(
  behavior: {
    userMessageCount?: number
    assistantUsageTokens?: number
    assistantModelMissing?: boolean
    assistantModelMalformed?: boolean
    lastMessageCompaction?: "summary" | "part"
    messagesDelayMs?: number
    summarizeDelayMs?: number
    summarizeError?: unknown
    summarizeThrows?: boolean
  } = {},
) {
  const summarizeCalls: Array<{
    sessionId: string
    providerId: string
    modelId: string
  }> = []
  const summarizeAutoValues: boolean[] = []
  const requestSignals: unknown[] = []
  const logMessages: string[] = []
  const messageRecords: unknown[] = []
  const userMessageCount = behavior.userMessageCount ?? 1
  for (let position = 0; position < userMessageCount; position++) {
    messageRecords.push({ info: { role: "user" } })
  }
  if (userMessageCount > 0) {
    const assistantInfo: Record<string, unknown> = {
      role: "assistant",
      time: { created: 2, completed: 3 },
      tokens: {
        input: behavior.assistantUsageTokens ?? 40_000,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }
    if (!behavior.assistantModelMissing) {
      assistantInfo.providerID = behavior.assistantModelMalformed
        ? "bad id"
        : "fake"
      assistantInfo.modelID = "fake-model"
    }
    messageRecords.push({ info: assistantInfo })
  }
  if (behavior.lastMessageCompaction === "summary") {
    messageRecords.push({ info: { role: "assistant", summary: true } })
  }
  if (behavior.lastMessageCompaction === "part") {
    messageRecords.push({
      info: { role: "user" },
      parts: [{ type: "compaction" }],
    })
  }

  return {
    summarizeCalls,
    summarizeAutoValues,
    requestSignals,
    logMessages,
    client: {
      session: {
        messages: async (request: { signal?: unknown }) => {
          requestSignals.push(request.signal)
          if (behavior.messagesDelayMs) {
            await sleep(behavior.messagesDelayMs)
          }
          return { data: messageRecords }
        },
        summarize: async (request: {
          path: { id: string }
          body: { providerID: string; modelID: string; auto?: boolean }
        }) => {
          summarizeCalls.push({
            sessionId: request.path.id,
            providerId: request.body.providerID,
            modelId: request.body.modelID,
          })
          summarizeAutoValues.push(request.body.auto ?? false)
          if (behavior.summarizeDelayMs) {
            await sleep(behavior.summarizeDelayMs)
          }
          if (behavior.summarizeThrows) {
            throw new Error("connection dropped mid-request")
          }
          if (behavior.summarizeError) {
            return { error: behavior.summarizeError }
          }
          return { data: true }
        },
      },
      app: {
        log: async (entry: { body: { message: string } }) => {
          logMessages.push(entry.body.message)
        },
      },
    },
  }
}

async function startCompactor(
  fake: ReturnType<typeof fakeClient>,
  options: Record<string, unknown> = { idleTimeoutMs: SHORT_IDLE_MS },
) {
  return idleAutoCompactorFeature.buildHooks({
    client: fake.client as unknown as PluginInput["client"],
    options,
  })
}

describe("idle-auto-compactor", () => {
  it("compacts a session once after it stays idle", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 1)
    assert.deepEqual(fake.summarizeCalls[0], {
      sessionId: "s1",
      providerId: "fake",
      modelId: "fake-model",
    })
    assert.deepEqual(fake.summarizeAutoValues, [false])
    await hooks.dispose?.()
  })

  it("cancels the timer when the session becomes busy", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(SHORT_IDLE_MS / 4)
    await hooks.event?.({ event: sessionStatusEvent("s1", "busy") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    await hooks.dispose?.()
  })

  it("compacts again after genuine activity and a fresh idle period", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)
    await hooks["chat.message"]?.(
      { sessionID: "s1" },
      { message: userMessage("s1"), parts: [] },
    )
    await hooks.event?.({ event: sessionStatusEvent("s1", "busy") })
    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 2)
    await hooks.dispose?.()
  })

  it("ignores the busy/idle echo emitted by its own compaction", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)
    await hooks.event?.({ event: sessionStatusEvent("s1", "busy") })
    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 1)
    await hooks.dispose?.()
  })

  it("a new user message reopens the idle period", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)
    await hooks["chat.message"]?.(
      { sessionID: "s1" },
      { message: userMessage("s1"), parts: [] },
    )
    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 2)
    await hooks.dispose?.()
  })

  it("a user message cancels a running timer", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(SHORT_IDLE_MS / 4)
    await hooks["chat.message"]?.(
      { sessionID: "s1" },
      { message: userMessage("s1"), parts: [] },
    )
    await sleep(LONGER_THAN_IDLE_MS)
    assert.equal(fake.summarizeCalls.length, 0)

    await hooks.event?.({ event: sessionStatusEvent("s1", "busy") })
    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)
    assert.equal(fake.summarizeCalls.length, 1)
    await hooks.dispose?.()
  })

  it("status echoes during a slow compaction do not re-trigger", async () => {
    const fake = fakeClient({ summarizeDelayMs: SHORT_IDLE_MS + 40 })
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(SHORT_IDLE_MS + 10)
    await hooks.event?.({ event: sessionStatusEvent("s1", "busy") })
    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 1)
    await hooks.dispose?.()
  })

  it("skips compaction for a session without user messages", async () => {
    const fake = fakeClient({ userMessageCount: 0 })
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    await hooks.dispose?.()
  })

  it("skips when the newest message is a compaction summary", async () => {
    const fake = fakeClient({ lastMessageCompaction: "summary" })
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    assert.ok(fake.logMessages.includes("IdleCompactionSkippedAfterCompaction"))
    await hooks.dispose?.()
  })

  it("skips when the newest user message contains a compaction part", async () => {
    const fake = fakeClient({ lastMessageCompaction: "part" })
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    assert.ok(fake.logMessages.includes("IdleCompactionSkippedAfterCompaction"))
    await hooks.dispose?.()
  })

  it("skips when the newest answer used fewer than 32000 tokens", async () => {
    const fake = fakeClient({ assistantUsageTokens: 31_999 })
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    assert.ok(fake.logMessages.includes("IdleCompactionSkippedSmallContext"))
    await hooks.dispose?.()
  })

  it("compacts when the newest answer used exactly 32000 tokens", async () => {
    const fake = fakeClient({ assistantUsageTokens: 32_000 })
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 1)
    await hooks.dispose?.()
  })

  it("clears the timer when the session is deleted", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(SHORT_IDLE_MS / 4)
    await hooks.event?.({ event: sessionDeletedEvent("s1") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    await hooks.dispose?.()
  })

  it("tracks each session independently", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await hooks.event?.({ event: sessionStatusEvent("s2", "idle") })
    await sleep(SHORT_IDLE_MS / 4)
    await hooks.event?.({ event: sessionStatusEvent("s1", "busy") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.deepEqual(
      fake.summarizeCalls.map((call) => call.sessionId),
      ["s2"],
    )
    await hooks.dispose?.()
  })

  it("dispose clears pending timers", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await hooks.dispose?.()
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
  })

  it("a rejected compaction settles the idle period once", async () => {
    const fake = fakeClient({ summarizeError: { name: "BadRequestError" } })
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)
    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 1)
    assert.ok(fake.logMessages.includes("IdleCompactionRejected"))
    await hooks.dispose?.()
  })

  it("a throwing compaction is logged and settles the idle period", async () => {
    const fake = fakeClient({ summarizeThrows: true })
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)
    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 1)
    assert.ok(fake.logMessages.includes("IdleCompactionFailed"))
    await hooks.dispose?.()
  })

  it("a completed answer without a model skips compaction", async () => {
    const fake = fakeClient({ assistantModelMissing: true })
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    assert.ok(fake.logMessages.includes("IdleCompactionTurnRejected"))
    await hooks.dispose?.()
  })

  it("a retry status does not cancel or re-arm the idle timer", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(SHORT_IDLE_MS / 4)
    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionId: "s1",
          status: {
            type: "retry",
            attempt: 1,
            message: "backing off",
            next: 0,
          },
        },
      } as unknown as Event,
    })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 1)
    await hooks.dispose?.()
  })

  it("events for unknown or malformed sessions are ignored", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks["chat.message"]?.(
      { sessionID: "" },
      { message: userMessage(""), parts: [] },
    )
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: {} },
      } as unknown as Event,
    })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    await hooks.dispose?.()
  })

  it("unknown event types are ignored", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks.event?.({
      event: { type: "server.connected" } as unknown as Event,
    })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    await hooks.dispose?.()
  })

  it("does not arm timers while the feature is disabled", async () => {
    const fake = fakeClient()
    writeFeatureEnabled(idleAutoCompactorFeature.id, false)
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    await hooks.dispose?.()
  })

  it("does not arm timers while the global switch is off", async () => {
    const fake = fakeClient()
    writeGlobalEnabled(false)
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    await hooks.dispose?.()
  })

  it("logs a clamp when a stored timeout exceeds the timer ceiling", async () => {
    const fake = fakeClient()
    writeIdleTimeoutMs(idleAutoCompactorFeature.id, OVER_CEILING_TIMEOUT_MS)
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })

    assert.ok(fake.logMessages.includes("IdleTimeoutMsClamped"))
    assert.equal(fake.summarizeCalls.length, 0)
    await hooks.dispose?.()
  })

  it("prefers the configured timeout over the plugin option", async () => {
    const fake = fakeClient()
    writeIdleTimeoutMs(idleAutoCompactorFeature.id, SHORT_IDLE_TIMEOUT_MS)
    const hooks = await startCompactor(fake, {
      idleTimeoutMs: 10 * LONGER_THAN_IDLE_MS,
    })

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 1)
    await hooks.dispose?.()
  })

  it("a timer armed before disabling never compacts", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(SHORT_IDLE_MS / 4)
    writeFeatureEnabled(idleAutoCompactorFeature.id, false)
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    await hooks.dispose?.()
  })

  it("re-enabling the feature arms the next idle period", async () => {
    const fake = fakeClient()
    writeFeatureEnabled(idleAutoCompactorFeature.id, false)
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)
    assert.equal(fake.summarizeCalls.length, 0)

    writeFeatureEnabled(idleAutoCompactorFeature.id, true)
    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 1)
    await hooks.dispose?.()
  })

  it("an unreadable state file keeps the last known decision", async () => {
    const fake = fakeClient()
    writeFeatureEnabled(idleAutoCompactorFeature.id, false)
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    assert.equal(fake.logMessages.includes("EssentialsConfigReadFailed"), false)

    try {
      chmodSync(resolveEssentialsStatePath(), 0o000)
      await hooks.event?.({ event: sessionStatusEvent("s2", "idle") })
      await sleep(LONGER_THAN_IDLE_MS)
    } finally {
      chmodSync(resolveEssentialsStatePath(), 0o644)
    }

    assert.equal(fake.summarizeCalls.length, 0)
    assert.ok(fake.logMessages.includes("EssentialsConfigReadFailed"))
    await hooks.dispose?.()
  })

  it("two idle events in the same tick arm one timer", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    const first = hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    const second = hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await Promise.all([first, second])
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 1)
    await hooks.dispose?.()
  })

  it("compaction requests carry an abort signal deadline", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.requestSignals.length, 1)
    assert.ok(fake.requestSignals[0] instanceof AbortSignal)
    await hooks.dispose?.()
  })

  it("dispose during a slow message read prevents the summarize call", async () => {
    const fake = fakeClient({ messagesDelayMs: SHORT_IDLE_MS + 60 })
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(SHORT_IDLE_MS + 10)
    await hooks.dispose?.()
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    assert.ok(fake.logMessages.includes("IdleCompactionSkippedDisposed"))
  })

  it("skips when the completed answer has a malformed model", async () => {
    const fake = fakeClient({ assistantModelMalformed: true })
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    assert.ok(fake.logMessages.includes("IdleCompactionTurnRejected"))
    await hooks.dispose?.()
  })

  const rejectedSessionIds = ["..", "ses/../other", "with space", "é"]

  for (const sessionId of rejectedSessionIds) {
    const label = JSON.stringify(sessionId)
    it(`a session id shaped like ${label} is ignored`, async () => {
      const fake = fakeClient()
      const hooks = await startCompactor(fake)

      await hooks.event?.({ event: sessionStatusEvent(sessionId, "idle") })
      await sleep(LONGER_THAN_IDLE_MS)

      assert.equal(fake.summarizeCalls.length, 0)
      assert.equal(fake.requestSignals.length, 0)
      await hooks.dispose?.()
    })
  }

  const invalidTimeoutValues: Array<[string, unknown]> = [
    ["a string", "900000"],
    ["null", null],
    ["a boolean", true],
    ["an object", {}],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["a negative number", -5],
  ]

  for (const [label, value] of invalidTimeoutValues) {
    it(`an invalid idleTimeoutMs (${label}) falls back to the default`, async () => {
      const fake = fakeClient()
      const hooks = await startCompactor(fake, { idleTimeoutMs: value })

      await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
      await sleep(LONGER_THAN_IDLE_MS)

      assert.equal(fake.summarizeCalls.length, 0)
      assert.ok(fake.logMessages.includes("InvalidIdleTimeoutMs"))
      await hooks.dispose?.()
    })
  }

  it("an idleTimeoutMs above the timer ceiling is clamped", async () => {
    const fake = fakeClient()
    const hooks = await startCompactor(fake, { idleTimeoutMs: 2 ** 31 })

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
    assert.ok(fake.logMessages.includes("IdleTimeoutMsClamped"))
    await hooks.dispose?.()
  })
})
