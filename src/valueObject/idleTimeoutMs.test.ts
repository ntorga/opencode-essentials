import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  clampIdleTimeoutToTimerDelay,
  MAX_TIMER_DELAY_MS,
  newIdleTimeoutMs,
} from "./idleTimeoutMs.ts"

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

  it("clamps a configured delay to the host timer ceiling", () => {
    const requestedTimeout = newIdleTimeoutMs(MAX_TIMER_DELAY_MS + 1)
    assert.ok(requestedTimeout)
    assert.equal(
      clampIdleTimeoutToTimerDelay(requestedTimeout),
      MAX_TIMER_DELAY_MS,
    )
  })
})
