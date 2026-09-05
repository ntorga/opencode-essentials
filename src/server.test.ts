import { describe, it, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Event } from "@opencode-ai/sdk"
import type { PluginInput } from "@opencode-ai/plugin"
import { newFeatureId } from "./valueObject/featureId.ts"
import { writeFeatureEnabled } from "./state.ts"
import suite from "./server.ts"

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

function fakeClient() {
  const summarizeCalls: string[] = []
  return {
    summarizeCalls,
    client: {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                role: "user",
                model: { providerID: "fake", modelID: "fake-model" },
              },
            },
          ],
        }),
        summarize: async (request: { path: { id: string } }) => {
          summarizeCalls.push(request.path.id)
          return { data: true }
        },
      },
      app: { log: async () => undefined },
    },
  }
}

describe("essentials server entry", () => {
  it("exports an id and a server plugin function", () => {
    assert.equal(suite.id, "opencode-essentials")
    assert.equal(typeof suite.server, "function")
  })

  it("routes per-feature options to the feature", async () => {
    const fake = fakeClient()
    const hooks = await suite.server(
      { client: fake.client } as unknown as PluginInput,
      { features: { "idle-auto-compactor": { idleTimeoutMs: SHORT_IDLE_MS } } },
    )

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "idle" } },
      } as unknown as Event,
    })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.deepEqual(fake.summarizeCalls, ["s1"])
    await hooks.dispose?.()
  })

  it("ignores options for unknown features", async () => {
    const fake = fakeClient()
    const hooks = await suite.server(
      { client: fake.client } as unknown as PluginInput,
      { features: { "not-a-feature": { idleTimeoutMs: 1 } } },
    )

    assert.ok(hooks.event)
    await hooks.dispose?.()
  })

  it("obeys a toggle written in the state file without a restart", async () => {
    const fake = fakeClient()
    const featureId = newFeatureId("idle-auto-compactor")
    assert.ok(featureId)
    writeFeatureEnabled(featureId, false)
    const hooks = await suite.server(
      { client: fake.client } as unknown as PluginInput,
      { features: { "idle-auto-compactor": { idleTimeoutMs: SHORT_IDLE_MS } } },
    )

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "idle" } },
      } as unknown as Event,
    })
    await sleep(LONGER_THAN_IDLE_MS)

    assert.deepEqual(fake.summarizeCalls, [])
    await hooks.dispose?.()
  })
})
