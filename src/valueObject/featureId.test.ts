import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { newFeatureId } from "./featureId.ts"

describe("FeatureId", () => {
  const accepted: unknown[] = [
    "idle-auto-compactor",
    "exec.guard",
    "o11y",
    "a".repeat(128),
  ]

  for (const candidate of accepted) {
    it(`accepts ${candidate}`, () => {
      assert.equal(newFeatureId(candidate), candidate)
    })
  }

  const rejected: unknown[] = [
    undefined,
    null,
    7,
    {},
    [],
    "",
    ".hidden",
    "..",
    "with space",
    "a/b",
    "é",
    "a".repeat(129),
  ]

  for (const candidate of rejected) {
    it(`rejects ${JSON.stringify(candidate)}`, () => {
      assert.equal(newFeatureId(candidate), undefined)
    })
  }
})
