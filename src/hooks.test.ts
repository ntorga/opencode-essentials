import { test } from "node:test"
import assert from "node:assert/strict"
import type { Event } from "@opencode-ai/sdk"
import type { Hooks } from "@opencode-ai/plugin"
import { combineHooks } from "./hooks.ts"

function serverConnectedEvent(): Event {
  return { type: "server.connected" } as unknown as Event
}

test("combineHooks fans an event out to every handler in order", async () => {
  const visitOrder: string[] = []
  const first: Hooks = {
    event: async () => {
      visitOrder.push("first")
    },
  }
  const second: Hooks = {
    event: async () => {
      visitOrder.push("second")
    },
  }

  const combined = combineHooks([first, second])
  await combined.event?.({ event: serverConnectedEvent() })

  assert.deepEqual(visitOrder, ["first", "second"])
})

test("combineHooks skips missing handlers and fans out dispose", async () => {
  const disposed: string[] = []
  const withDispose: Hooks = {
    dispose: async () => {
      disposed.push("withDispose")
    },
  }
  const empty: Hooks = {}

  const combined = combineHooks([empty, withDispose])
  await combined.event?.({ event: serverConnectedEvent() })
  await combined.dispose?.()

  assert.ok(combined.event)
  assert.deepEqual(disposed, ["withDispose"])
})

test("combineHooks fans chat.message out with its output argument", async () => {
  const seen: string[] = []
  const first: Hooks = {
    "chat.message": async (input, output) => {
      seen.push(`${input.sessionID}:${output.message.role}`)
    },
  }
  const second: Hooks = {
    "chat.message": async (input) => {
      seen.push(input.sessionID)
    },
  }

  const combined = combineHooks([first, second])
  await combined["chat.message"]?.(
    { sessionID: "s1" },
    { message: { role: "user" } as never, parts: [] },
  )

  assert.deepEqual(seen, ["s1:user", "s1"])
})
