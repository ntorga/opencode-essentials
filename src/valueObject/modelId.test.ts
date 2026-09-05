import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { newModelId } from "./modelId.ts"

describe("ModelId", () => {
  const accepted: unknown[] = [
    "hyper/qwen3.8-flash",
    "claude-sonnet-4",
    "gpt-4.1",
  ]

  for (const candidate of accepted) {
    it(`accepts ${candidate}`, () => {
      assert.equal(newModelId(candidate), candidate)
    })
  }

  const rejected: unknown[] = [
    undefined,
    "",
    " leading space",
    "has space",
    "has\nnewline",
    "x".repeat(129),
  ]

  for (const candidate of rejected) {
    it(`rejects ${JSON.stringify(candidate)}`, () => {
      assert.equal(newModelId(candidate), undefined)
    })
  }
})
