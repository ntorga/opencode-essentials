import { describe, it, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Event, UserMessage } from "@opencode-ai/sdk"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  resolveEssentialsStatePath,
  writeFeatureEnabled,
} from "../state.ts"
import { idleAutoCompactorFeature } from "./idle-auto-compactor.ts"

// Note: Setup/teardown are intentionally inline — test independence
// requires each file to own its preconditions, even if it duplicates code.

const SHORT_IDLE_MS = 40
const LONGER_THAN_IDLE_MS = 120

let dataHomeTemp = ""
let previousDataHome: string | undefined

beforeEach(() => {
  previousDataHome = process.env["XDG_DATA_HOME"]
  dataHomeTemp = mkdtempSync(path.join(tmpdir(), "essentials-test-"))
  process.env["XDG_DATA_HOME"] = dataHomeTemp
})

afterEach(() => {
  // "" and unset behave the same: resolveEssentialsStatePath falls back to
  // ~/.local/share for both.
  process.env["XDG_DATA_HOME"] = previousDataHome ?? ""
  rmSync(dataHomeTemp, { recursive: true, force: true })
})

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function sessionStatusEvent(sessionID: string, status: "idle" | "busy"): Event {
  return {
    type: "session.status",
    properties: { sessionID, status: { type: status } },
  } as unknown as Event
}

function sessionDeletedEvent(sessionID: string): Event {
  return {
    type: "session.deleted",
    properties: { info: { id: sessionID } },
  } as unknown as Event
}

function userMessage(sessionID: string): UserMessage {
  return {
    id: "msg-test",
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "fake", modelID: "fake-model" },
  }
}

function fakeClient(behavior: {
  userMessageCount?: number
  modellessUserMessages?: boolean
  summarizeDelayMs?: number
  summarizeError?: unknown
  summarizeThrows?: boolean
} = {}) {
  const summarizeCalls: Array<{
    sessionID: string
    providerID: string
    modelID: string
  }> = []
  const logMessages: string[] = []
  const messageRecords: unknown[] = []
  const userMessageCount = behavior.userMessageCount ?? 1
  const lastUserMessageInfo: Record<string, unknown> = { role: "user" }
  if (!behavior.modellessUserMessages) {
    lastUserMessageInfo.model = {
      providerID: "fake",
      modelID: "fake-model",
    }
  }
  for (let position = 0; position < userMessageCount; position++) {
    messageRecords.push({ info: lastUserMessageInfo })
  }

  return {
    summarizeCalls,
    logMessages,
    client: {
      session: {
        messages: async () => ({ data: messageRecords }),
        summarize: async (request: {
          path: { id: string }
          body: { providerID: string; modelID: string }
        }) => {
          summarizeCalls.push({
            sessionID: request.path.id,
            providerID: request.body.providerID,
            modelID: request.body.modelID,
          })
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
      sessionID: "s1",
      providerID: "fake",
      modelID: "fake-model",
    })
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
      fake.summarizeCalls.map((call) => call.sessionID),
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

  it("a user message without a model skips compaction", async () => {
    const fake = fakeClient({ modellessUserMessages: true })
    const hooks = await startCompactor(fake)

    await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.equal(fake.summarizeCalls.length, 0)
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
          sessionID: "s1",
          status: { type: "retry", attempt: 1, message: "backing off", next: 0 },
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
    assert.equal(fake.logMessages.includes("FeatureStatesReadFailed"), false)

    chmodSync(resolveEssentialsStatePath(), 0o000)
    await hooks.event?.({ event: sessionStatusEvent("s2", "idle") })
    await sleep(LONGER_THAN_IDLE_MS)
    chmodSync(resolveEssentialsStatePath(), 0o644)

    assert.equal(fake.summarizeCalls.length, 0)
    assert.ok(fake.logMessages.includes("FeatureStatesReadFailed"))
    await hooks.dispose?.()
  })

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
