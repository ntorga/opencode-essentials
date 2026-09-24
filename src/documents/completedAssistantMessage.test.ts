import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { newCompletedAssistantMessage } from "./completedAssistantMessage.ts"

const T0 = 1_757_000_000_000

function assistantPayload(tokens: Record<string, unknown>) {
  return {
    id: "msg_assistant",
    role: "assistant",
    time: { created: T0, completed: T0 + 5_000 },
    tokens,
  }
}

describe("newCompletedAssistantMessage", () => {
  it("rejects a malformed output token count", () => {
    assert.equal(
      newCompletedAssistantMessage(assistantPayload({ output: Number.NaN })),
      undefined,
    )
  })

  it("accepts a payload without input, cache, or reasoning counts", () => {
    const message = newCompletedAssistantMessage(
      assistantPayload({ output: 25 }),
    )
    assert.ok(message)
    assert.equal(message.outputTokens, 25)
    assert.equal(message.reasoningTokens, 0)
  })
})
