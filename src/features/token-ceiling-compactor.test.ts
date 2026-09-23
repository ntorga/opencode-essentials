import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Event, UserMessage } from "@opencode-ai/sdk"
import {
  writeFeatureEnabled,
  writeGlobalEnabled,
  writeTokenCeiling,
} from "../state.ts"
import type { ContextTokens } from "../valueObject/contextTokens.ts"
import { tokenCeilingCompactorFeature } from "./token-ceiling-compactor.ts"

// Note: Setup/teardown are intentionally inline — test independence
// requires each file to own its preconditions, even if it duplicates code.

const CEILING_UNDER_TEST = 1000 as ContextTokens
const WINDOW_ABOVE_ANY_CEILING = 10_000_000
const LONGER_THAN_REQUEST_MS = 120

let dataHomeTemp = ""
let previousDataHome: string | undefined

beforeEach(() => {
  previousDataHome = process.env.XDG_DATA_HOME
  dataHomeTemp = mkdtempSync(path.join(tmpdir(), "essentials-test-"))
  process.env.XDG_DATA_HOME = dataHomeTemp
})

afterEach(() => {
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

function usageTokens(input: number, read: number) {
  return { input, output: 0, reasoning: 0, cache: { read, write: 0 } }
}

function assistantRecord(input: {
  tokens: unknown
  providerID?: string
  modelID?: string
  summary?: boolean
  unfinished?: boolean
}) {
  const info: Record<string, unknown> = {
    role: "assistant",
    providerID: input.providerID ?? "fake",
    modelID: input.modelID ?? "fake-model",
    time: input.unfinished ? { created: 1 } : { created: 1, completed: 5 },
    tokens: input.tokens,
  }
  if (input.summary !== undefined) info.summary = input.summary
  return { info }
}

function fakeClient(
  behavior: {
    assistantRecords?: unknown[]
    providerContext?: number | null | "error"
    messagesDelayMs?: number
    summarizeError?: unknown
    summarizeThrows?: boolean
  } = {},
) {
  const summarizeCalls: Array<{ sessionId: string; modelId: string }> = []
  const summarizeAutoValues: boolean[] = []
  const logMessages: string[] = []
  let messageReadCount = 0
  const records = behavior.assistantRecords ?? [
    assistantRecord({ tokens: usageTokens(400, 700) }),
  ]

  return {
    summarizeCalls,
    logMessages,
    summarizeAutoValues,
    messageReadCount: () => messageReadCount,
    client: {
      session: {
        messages: async () => {
          messageReadCount += 1
          if (behavior.messagesDelayMs) await sleep(behavior.messagesDelayMs)
          return { data: records }
        },
        summarize: async (request: {
          path: { id: string }
          body: { providerID: string; modelID: string; auto?: boolean }
          signal?: unknown
        }) => {
          summarizeCalls.push({
            sessionId: request.path.id,
            modelId: request.body.modelID,
          })
          summarizeAutoValues.push(request.body.auto ?? false)
          if (behavior.summarizeThrows) {
            throw new Error("connection dropped mid-request")
          }
          if (behavior.summarizeError) return { error: behavior.summarizeError }
          return { data: true }
        },
      },
      provider: {
        list: async () => {
          if (behavior.providerContext === "error") {
            return { error: new Error("provider registry unavailable") }
          }
          if (behavior.providerContext === null) {
            return { data: { all: [] } }
          }
          return {
            data: {
              all: [
                {
                  id: "fake",
                  models: {
                    "fake-model": {
                      limit: {
                        context:
                          behavior.providerContext ?? WINDOW_ABOVE_ANY_CEILING,
                      },
                    },
                  },
                },
              ],
            },
          }
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

async function startCeiling(
  fake: ReturnType<typeof fakeClient>,
  options: Record<string, unknown> = { ceilingTokens: CEILING_UNDER_TEST },
) {
  return tokenCeilingCompactorFeature.buildHooks({
    client: fake.client as unknown as PluginInput["client"],
    options,
  })
}

// The idle handler detaches the check (it must not stall the event
// fan-out), so a test flush needs one macrotask boundary after the event.
async function idleOnce(
  hooks: Awaited<ReturnType<typeof tokenCeilingCompactorFeature.buildHooks>>,
) {
  await hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
  await sleep(0)
}

describe("token-ceiling-compactor", () => {
  it("compacts when the newest turn meets the ceiling", async () => {
    const fake = fakeClient()
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)

    assert.deepEqual(fake.summarizeCalls, [
      { sessionId: "s1", modelId: "fake-model" },
    ])
    assert.deepEqual(fake.summarizeAutoValues, [true])
    assert.match(fake.logMessages.join("|"), /CeilingCompactionCompleted/)
    await hooks.dispose?.()
  })

  it("does not compact below the ceiling", async () => {
    const fake = fakeClient({
      assistantRecords: [assistantRecord({ tokens: usageTokens(999, 0) })],
    })
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)

    assert.deepEqual(fake.summarizeCalls, [])
    assert.match(fake.logMessages.join("|"), /CeilingNotReached/)
    await hooks.dispose?.()
  })

  it("measures the newest real turn, never the compaction summary", async () => {
    const fake = fakeClient({
      assistantRecords: [
        assistantRecord({ tokens: usageTokens(500, 400) }),
        assistantRecord({ tokens: usageTokens(900, 900), summary: true }),
      ],
    })
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)

    assert.deepEqual(fake.summarizeCalls, [])
    await hooks.dispose?.()
  })

  it("settles the idle period: repeat idles do not re-check", async () => {
    const fake = fakeClient()
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)
    await hooks.event?.({ event: sessionStatusEvent("s1", "busy") })
    await idleOnce(hooks)
    await idleOnce(hooks)

    assert.deepEqual(fake.summarizeCalls, [
      { sessionId: "s1", modelId: "fake-model" },
    ])
    assert.equal(fake.messageReadCount(), 1)
    await hooks.dispose?.()
  })

  it("absorbs the busy/idle echo of its own compaction", async () => {
    const fake = fakeClient()
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)
    await hooks.event?.({ event: sessionStatusEvent("s1", "busy") })
    await idleOnce(hooks)

    assert.equal(fake.summarizeCalls.length, 1)
    await hooks.dispose?.()
  })

  it("re-checks after a genuine user message", async () => {
    const fake = fakeClient()
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)
    await hooks["chat.message"]?.(
      { sessionID: "s1" },
      { message: userMessage("s1"), parts: [] },
    )
    await hooks.event?.({ event: sessionStatusEvent("s1", "busy") })
    await idleOnce(hooks)

    assert.equal(fake.summarizeCalls.length, 2)
    await hooks.dispose?.()
  })

  it("clamps to a smaller model window and still compacts", async () => {
    const fake = fakeClient({
      providerContext: 1500,
      assistantRecords: [assistantRecord({ tokens: usageTokens(1600, 0) })],
    })
    const hooks = await startCeiling(fake, { ceilingTokens: 5000 })

    await idleOnce(hooks)

    assert.equal(fake.summarizeCalls.length, 1)
    assert.match(fake.logMessages.join("|"), /CeilingClampedToModelWindow/)
    await hooks.dispose?.()
  })

  it("treats a corrupt tiny window as unknown and keeps the ceiling", async () => {
    const fake = fakeClient({
      providerContext: 10,
      assistantRecords: [assistantRecord({ tokens: usageTokens(900, 0) })],
    })
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)

    assert.deepEqual(fake.summarizeCalls, [])
    await hooks.dispose?.()
  })

  it("keeps the requested ceiling when the model window is unknown", async () => {
    const fake = fakeClient({
      providerContext: null,
      assistantRecords: [assistantRecord({ tokens: usageTokens(1000, 0) })],
    })
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)

    assert.equal(fake.summarizeCalls.length, 1)
    assert.match(fake.logMessages.join("|"), /CeilingModelWindowUnknown/)
    await hooks.dispose?.()
  })

  it("tolerates a provider-list failure with the requested ceiling", async () => {
    const fake = fakeClient({
      providerContext: "error",
      assistantRecords: [assistantRecord({ tokens: usageTokens(1000, 0) })],
    })
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)

    assert.equal(fake.summarizeCalls.length, 1)
    assert.match(fake.logMessages.join("|"), /CeilingProviderListFailed/)
    await hooks.dispose?.()
  })

  it("prefers the stored ceiling over the plugin option", async () => {
    writeTokenCeiling(tokenCeilingCompactorFeature.id, 5000 as ContextTokens)
    const fake = fakeClient({
      assistantRecords: [assistantRecord({ tokens: usageTokens(1100, 0) })],
    })
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)

    assert.deepEqual(fake.summarizeCalls, [])
    await hooks.dispose?.()
  })

  it("reads no state when the master switch is off", async () => {
    writeGlobalEnabled(false)
    const fake = fakeClient()
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)

    assert.equal(fake.messageReadCount(), 0)
    assert.deepEqual(fake.summarizeCalls, [])
    await hooks.dispose?.()
  })

  it("stays quiet while the feature flag is off", async () => {
    writeFeatureEnabled(tokenCeilingCompactorFeature.id, false)
    const fake = fakeClient()
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)

    assert.equal(fake.messageReadCount(), 0)
    await hooks.dispose?.()
  })

  it("falls back to the built-in default when the option is invalid", async () => {
    const fake = fakeClient({
      assistantRecords: [
        assistantRecord({ tokens: usageTokens(200_000, 200_000) }),
      ],
    })
    const hooks = await startCeiling(fake, { ceilingTokens: -7 })

    await idleOnce(hooks)

    assert.match(fake.logMessages.join("|"), /InvalidCeilingTokens/)
    assert.equal(fake.summarizeCalls.length, 1)
    await hooks.dispose?.()
  })

  it("abandons the check when no completed real answer exists", async () => {
    const fake = fakeClient({
      assistantRecords: [
        { info: { role: "user", time: { created: 1 } } },
        assistantRecord({ tokens: usageTokens(9000, 9000), unfinished: true }),
      ],
    })
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)

    assert.equal(fake.messageReadCount(), 1)
    assert.deepEqual(fake.summarizeCalls, [])
    assert.match(fake.logMessages.join("|"), /CeilingNoFinishedTurn/)
    await hooks.dispose?.()
  })

  it("does not compact after dispose arrives mid-check", async () => {
    const fake = fakeClient({ messagesDelayMs: 40 })
    const hooks = await startCeiling(fake)

    void hooks.event?.({ event: sessionStatusEvent("s1", "idle") })
    await hooks.dispose?.()
    await sleep(LONGER_THAN_REQUEST_MS)

    assert.deepEqual(fake.summarizeCalls, [])
    assert.match(fake.logMessages.join("|"), /CeilingSkippedDisposed/)
  })

  it("maps a rejected summarize to a warning without throwing", async () => {
    const fake = fakeClient({ summarizeError: { message: "busy" } })
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)

    assert.match(fake.logMessages.join("|"), /CeilingCompactionRejected/)
    await hooks.dispose?.()
  })

  it("maps a thrown summarize to a warning without throwing", async () => {
    const fake = fakeClient({ summarizeThrows: true })
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)

    assert.match(fake.logMessages.join("|"), /CeilingCompactionFailed/)
    await hooks.dispose?.()
  })

  it("re-checks a session after it is deleted and idles again", async () => {
    const fake = fakeClient()
    const hooks = await startCeiling(fake)

    await idleOnce(hooks)
    await hooks.event?.({
      event: sessionDeletedEvent("s1"),
    })
    await idleOnce(hooks)

    assert.equal(fake.summarizeCalls.length, 2)
    await hooks.dispose?.()
  })

  it("warns on events carrying a rejected session id", async () => {
    const fake = fakeClient()
    const hooks = await startCeiling(fake)

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: "", status: { type: "idle" } },
      } as never,
    })

    assert.match(fake.logMessages.join("|"), /CeilingEventSessionIdRejected/)
    assert.deepEqual(fake.summarizeCalls, [])
    await hooks.dispose?.()
  })
})
