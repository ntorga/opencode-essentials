import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Event, UserMessage } from "@opencode-ai/sdk"
import { writeFeatureEnabled } from "../state.ts"
import { newFeatureId } from "../valueObject/featureId.ts"
import {
  detectRepeatedPhrase,
  reasoningLoopGuardFeature,
  splitReasoningWords,
} from "./reasoning-loop-guard.ts"

const GUARD_ID = newFeatureId("reasoning-loop-guard")
const originalFetch = globalThis.fetch

function repeatedWords(
  count: number,
  build: (index: number) => string,
): string {
  const words: string[] = []
  for (let index = 0; index < count; index += 1) {
    words.push(build(index))
  }
  return words.join(" ")
}

const PHRASE_TEXT = repeatedWords(24, (index) => `alpha${index}`)
const PHRASE_WORDS = splitReasoningWords(PHRASE_TEXT)
const SPIRAL_TEXT = `${repeatedWords(60, (index) => `fill${index}`)} ${PHRASE_TEXT} ${PHRASE_TEXT} ${PHRASE_TEXT}`

function spiralText(round: number): string {
  const words: string[] = []
  for (let index = 0; index < 700 * (round + 1); index += 1) {
    words.push(`w${index}`)
  }
  const phrase = PHRASE_WORDS.join(" ")
  return `${words.join(" ")} ${phrase} ${phrase} ${phrase}`
}

function words(count: number, prefix: string): string[] {
  const generated: string[] = []
  for (let index = 0; index < count; index += 1) {
    generated.push(`${prefix}${index}`)
  }
  return generated
}

// Note: Setup/teardown are intentionally inline — test independence
// requires each file to own its preconditions, even if it duplicates code.

let dataHomeTemp = ""
let previousDataHome: string | undefined
let previousApiKey: string | undefined

beforeEach(() => {
  previousDataHome = process.env.XDG_DATA_HOME
  previousApiKey = process.env.OPENROUTER_API_KEY
  dataHomeTemp = mkdtempSync(path.join(tmpdir(), "essentials-test-"))
  process.env.XDG_DATA_HOME = dataHomeTemp
  process.env.OPENROUTER_API_KEY = "sk-or-test-key"
})

afterEach(() => {
  // "" and unset behave the same for both variables: the credential
  // constructor rejects an empty key, and the state path falls back home.
  process.env.XDG_DATA_HOME = previousDataHome ?? ""
  process.env.OPENROUTER_API_KEY = previousApiKey ?? ""
  rmSync(dataHomeTemp, { recursive: true, force: true })
  globalThis.fetch = originalFetch
})

type FetchControl = {
  resolve: (probability: number) => void
  bodies: Record<string, unknown>[]
}

function stubDecisionsFetch(): FetchControl {
  const control: FetchControl = { resolve: () => {}, bodies: [] }
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    control.bodies.push(JSON.parse(String(init?.body)))
    return new Promise<Response>((resolve) => {
      control.resolve = (probability: number) =>
        resolve(
          new Response(
            JSON.stringify({
              answers: { stuck: { type: "noul", noul: probability } },
            }),
            { status: 200 },
          ),
        )
    })
  }) as unknown as typeof fetch
  return control
}

function reasoningPartEvent(
  sessionId: string,
  messageId: string,
  text: string,
): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: `prt_${messageId}`,
        sessionID: sessionId,
        messageID: messageId,
        type: "reasoning",
        text,
        time: { start: 1 },
      },
    },
  } as unknown as Event
}

function sessionIdleEvent(sessionId: string): Event {
  return {
    type: "session.status",
    properties: { sessionID: sessionId, status: { type: "idle" } },
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

function fakeClient() {
  const abortCalls: string[] = []
  const promptRequests: { sessionId: string; text: string }[] = []
  const logMessages: string[] = []
  return {
    abortCalls,
    promptRequests,
    logMessages,
    client: {
      session: {
        abort: async (request: { path: { id: string } }) => {
          abortCalls.push(request.path.id)
          return { data: true }
        },
        promptAsync: async (request: {
          path: { id: string }
          body: { parts: { type: string; text: string }[] }
        }) => {
          promptRequests.push({
            sessionId: request.path.id,
            text: request.body.parts[0]?.text ?? "",
          })
          return {}
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

async function startGuard(fake: ReturnType<typeof fakeClient>) {
  return reasoningLoopGuardFeature.buildHooks({
    client: fake.client as unknown as PluginInput["client"],
    options: {},
  })
}

async function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await sleep(5)
  }
}

describe("detectRepeatedPhrase", () => {
  it("needs the tail phrase three times inside the window", () => {
    assert.equal(detectRepeatedPhrase(PHRASE_WORDS), undefined)
    const twice = [...PHRASE_WORDS, ...PHRASE_WORDS]
    assert.equal(detectRepeatedPhrase(twice), undefined)
    const thrice = [...PHRASE_WORDS, ...PHRASE_WORDS, ...PHRASE_WORDS]
    assert.equal(detectRepeatedPhrase(thrice), PHRASE_WORDS.join(" "))
  })

  it("needs whole-token matches, not letter runs across word boundaries", () => {
    const gluedTail = [
      ...PHRASE_WORDS,
      ...PHRASE_WORDS,
      ...words(23, "alpha").slice(0, 23),
      "gluedalpha23",
    ]
    assert.equal(detectRepeatedPhrase(gluedTail), undefined)
  })

  it("flags a tail phrase that recurs with drift between repeats", () => {
    const drifting = [
      ...PHRASE_WORDS,
      ...words(24, "beta"),
      ...PHRASE_WORDS,
      ...words(24, "gamma"),
      ...PHRASE_WORDS,
    ]
    assert.equal(detectRepeatedPhrase(drifting), PHRASE_WORDS.join(" "))
  })
})

describe("reasoning-loop-guard", () => {
  it("interrupts a confirmed spiral and delivers the correction", async () => {
    const fake = fakeClient()
    const hooks = await startGuard(fake)
    const control = stubDecisionsFetch()

    await hooks.event?.({
      event: reasoningPartEvent("s1", "msg_spiral", SPIRAL_TEXT),
    })
    assert.equal(control.bodies.length, 1)
    control.resolve(0.95)
    await waitFor(() => fake.abortCalls.length === 1)

    assert.deepEqual(fake.abortCalls, ["s1"])
    assert.equal(fake.promptRequests.length, 1)
    assert.equal(fake.promptRequests[0]?.sessionId, "s1")
    assert.match(fake.promptRequests[0]?.text ?? "", /reasoning loop guard/)
    const sent = control.bodies[0] as {
      state: { items: string[] }
      questions: { stuck: { type: string } }
    }
    assert.equal(sent.state.items[0], PHRASE_WORDS.join(" "))
    assert.equal(sent.questions.stuck.type, "noul")
    await hooks.dispose?.()
  })

  it("leaves the response running when Jev clears the suspicion", async () => {
    const fake = fakeClient()
    const hooks = await startGuard(fake)
    const control = stubDecisionsFetch()

    await hooks.event?.({
      event: reasoningPartEvent("s1", "msg_recovered", SPIRAL_TEXT),
    })
    control.resolve(0.5)
    await waitFor(() =>
      fake.logMessages.includes("ReasoningLoopVerdictCleared"),
    )

    assert.equal(fake.abortCalls.length, 0)
    assert.equal(fake.promptRequests.length, 0)
    await hooks.dispose?.()
  })

  it("discards a verdict that arrives after the response ended", async () => {
    const fake = fakeClient()
    const hooks = await startGuard(fake)
    const control = stubDecisionsFetch()

    await hooks.event?.({
      event: reasoningPartEvent("s1", "msg_late", SPIRAL_TEXT),
    })
    await hooks.event?.({ event: sessionIdleEvent("s1") })
    control.resolve(0.95)
    await waitFor(() => fake.logMessages.includes("ReasoningLoopVerdictStale"))

    assert.equal(fake.abortCalls.length, 0)
    assert.equal(fake.promptRequests.length, 0)
    await hooks.dispose?.()
  })

  it("gives up after three confirmed spirals in one turn", async () => {
    const fake = fakeClient()
    const hooks = await startGuard(fake)

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const control = stubDecisionsFetch()
      await hooks.event?.({
        event: reasoningPartEvent("s1", `msg_spiral_${attempt}`, SPIRAL_TEXT),
      })
      control.resolve(0.95)
      await waitFor(() =>
        attempt <= 3
          ? fake.abortCalls.length === attempt
          : fake.logMessages.includes("ReasoningLoopGuardGaveUp"),
      )
      assert.equal(fake.abortCalls.length, Math.min(attempt, 3))
    }
    assert.equal(fake.promptRequests.length, 3)
    await hooks.dispose?.()
  })

  it("does not consult Jev while the feature is off", async () => {
    assert.ok(GUARD_ID)
    writeFeatureEnabled(GUARD_ID, false)
    const fake = fakeClient()
    const hooks = await startGuard(fake)
    const control = stubDecisionsFetch()

    await hooks.event?.({
      event: reasoningPartEvent("s1", "msg_disabled", SPIRAL_TEXT),
    })
    await sleep(20)

    assert.equal(control.bodies.length, 0)
    assert.equal(fake.abortCalls.length, 0)
    await hooks.dispose?.()
  })

  it("asks nothing when no credential exists, and logs once", async () => {
    delete process.env.OPENROUTER_API_KEY
    const fake = fakeClient()
    const hooks = await startGuard(fake)
    const control = stubDecisionsFetch()

    for (const messageId of ["msg_one", "msg_two"]) {
      await hooks.event?.({
        event: reasoningPartEvent("s1", messageId, SPIRAL_TEXT),
      })
    }
    await sleep(20)

    assert.equal(control.bodies.length, 0)
    assert.equal(
      fake.logMessages.filter((message) =>
        message.startsWith("ReasoningLoopCredentialMissing"),
      ).length,
      1,
    )
    await hooks.dispose?.()
  })

  it("cancels an uncleared loop after three abstentions, without a fourth verdict", async () => {
    const fake = fakeClient()
    const hooks = await startGuard(fake)

    for (let round = 0; round < 4; round += 1) {
      const control = stubDecisionsFetch()
      await hooks.event?.({
        event: reasoningPartEvent("s1", "msg_uncertain", spiralText(round)),
      })
      if (round === 3) {
        assert.equal(control.bodies.length, 0)
        continue
      }
      assert.equal(control.bodies.length, 1)
      control.resolve(0.1)
      const clearedSoFar = round + 1
      await waitFor(
        () =>
          fake.logMessages.filter(
            (message) => message === "ReasoningLoopVerdictCleared",
          ).length === clearedSoFar,
      )
    }

    await waitFor(() => fake.logMessages.includes("ReasoningLoopUnclearedCap"))
    await waitFor(
      () =>
        fake.promptRequests.length > 0 ||
        fake.logMessages.some((m) => m.startsWith("ReasoningLoopAbort")),
    )
    assert.equal(fake.abortCalls.length, 1)
    assert.match(fake.promptRequests[0]?.text ?? "", /did not clear/)
    await hooks.dispose?.()
  })

  it("escalates a loop the checks cannot reach, not only one Jev abstains on", async () => {
    const fake = fakeClient()
    const hooks = await startGuard(fake)
    globalThis.fetch = (async () =>
      new Response("classifier offline", {
        status: 500,
      })) as unknown as typeof globalThis.fetch

    for (let round = 0; round < 4; round += 1) {
      await hooks.event?.({
        event: reasoningPartEvent("s1", "msg_unreachable", spiralText(round)),
      })
      const failedSoFar = Math.min(round + 1, 3)
      await waitFor(
        () =>
          fake.logMessages.filter(
            (message) => message === "ReasoningLoopClassificationFailed",
          ).length === failedSoFar,
      )
    }

    await waitFor(() => fake.logMessages.includes("ReasoningLoopUnclearedCap"))
    await waitFor(() => fake.promptRequests.length > 0)
    assert.equal(fake.abortCalls.length, 1)
    assert.match(fake.promptRequests[0]?.text ?? "", /did not clear/)
    await hooks.dispose?.()
  })

  it("keeps the interrupt budget across its own correction prompts", async () => {
    const fake = fakeClient()
    const hooks = await startGuard(fake)

    async function spiralOnce(
      messageId: string,
      expectedInterrupts: number,
    ): Promise<void> {
      const control = stubDecisionsFetch()
      await hooks.event?.({
        event: reasoningPartEvent("s1", messageId, SPIRAL_TEXT),
      })
      control.resolve(0.95)
      await waitFor(
        () =>
          fake.abortCalls.length === expectedInterrupts &&
          fake.promptRequests.length === expectedInterrupts,
      )
      // The delivered correction re-enters as a real chat.message; it must
      // not look like a fresh user turn that refills the budget.
      await hooks["chat.message"]?.(
        { sessionID: "s1" },
        { message: userMessage("s1"), parts: [] },
      )
    }

    await spiralOnce("msg_spiral_1", 1)
    await spiralOnce("msg_spiral_2", 2)
    await spiralOnce("msg_spiral_3", 3)
    assert.equal(fake.abortCalls.length, 3)
    assert.equal(fake.promptRequests.length, 3)

    const control = stubDecisionsFetch()
    await hooks.event?.({
      event: reasoningPartEvent("s1", "msg_spiral_4", SPIRAL_TEXT),
    })
    control.resolve(0.95)
    await waitFor(() => fake.logMessages.includes("ReasoningLoopGuardGaveUp"))
    assert.equal(fake.abortCalls.length, 3)
    assert.equal(fake.promptRequests.length, 3)
    await hooks.dispose?.()
  })
})
