import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { newTimestampMs } from "./timestampMs.ts"

describe("TimestampMs", () => {
  const accepted: unknown[] = [
    978_307_200_000,
    1_757_000_000_000,
    Number.MAX_SAFE_INTEGER,
  ]

  for (const candidate of accepted) {
    it(`accepts ${candidate}`, () => {
      assert.equal(newTimestampMs(candidate), candidate)
    })
  }

  const rejected: unknown[] = [
    undefined,
    null,
    "1757000000000",
    true,
    {},
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    0,
    1_757_000_000,
    978_307_199_999,
  ]

  for (const candidate of rejected) {
    it(`rejects ${String(candidate)}`, () => {
      assert.equal(newTimestampMs(candidate), undefined)
    })
  }
})
