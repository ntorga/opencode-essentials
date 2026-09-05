import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { newIdleTimeoutMs } from "./idleTimeoutMs.ts"

describe("IdleTimeoutMs", () => {
  const accepted: unknown[] = [1, 0.5, 30 * 60 * 1000, 2 ** 31, 2 ** 40]

  for (const candidate of accepted) {
    it(`accepts ${candidate}`, () => {
      assert.equal(newIdleTimeoutMs(candidate), candidate)
    })
  }

  const rejected: unknown[] = [
    undefined,
    null,
    "900000",
    true,
    {},
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0,
    -5,
  ]

  for (const candidate of rejected) {
    it(`rejects ${String(candidate)}`, () => {
      assert.equal(newIdleTimeoutMs(candidate), undefined)
    })
  }
})
