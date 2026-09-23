import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  DEFAULT_TOKEN_CEILING,
  MAX_TOKEN_CEILING,
  newContextTokens,
  TOKEN_CEILING_PRESETS,
} from "./contextTokens.ts"

describe("ContextTokens", () => {
  const accepted: unknown[] = [1, 128_000, 384_000, 1_000_000, 2_000_000]

  for (const candidate of accepted) {
    it(`accepts ${candidate}`, () => {
      assert.equal(newContextTokens(candidate), candidate)
    })
  }

  const rejected: unknown[] = [
    undefined,
    null,
    "384000",
    true,
    {},
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0,
    -5,
    1.5,
    2_000_001,
    2 ** 53,
  ]

  for (const candidate of rejected) {
    it(`rejects ${String(candidate)}`, () => {
      assert.equal(newContextTokens(candidate), undefined)
    })
  }

  it("keeps the presets inside the type and the default a preset", () => {
    for (const preset of TOKEN_CEILING_PRESETS) {
      assert.notEqual(newContextTokens(preset), undefined)
    }
    assert.ok(TOKEN_CEILING_PRESETS.includes(DEFAULT_TOKEN_CEILING))
    assert.ok(MAX_TOKEN_CEILING >= 1_000_000)
  })
})
