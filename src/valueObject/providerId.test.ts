import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { newProviderId } from "./providerId.ts"

describe("ProviderId", () => {
  const accepted: unknown[] = ["opencode", "hyper", "openai-compatible"]

  for (const candidate of accepted) {
    it(`accepts ${candidate}`, () => {
      assert.equal(newProviderId(candidate), candidate)
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
      assert.equal(newProviderId(candidate), undefined)
    })
  }
})
