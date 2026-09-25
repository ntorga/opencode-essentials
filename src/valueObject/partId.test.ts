import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { newPartId } from "./partId.ts"

const ACCEPTED: unknown[] = ["prt_abc123", "part-1", "part_2", "A9_-"]
const REJECTED: unknown[] = [
  "",
  "part with space",
  "part/slash",
  "part.dot",
  "part!bang",
  "x".repeat(129),
  42,
  null,
  undefined,
  ["prt_1"],
]

describe("newPartId", () => {
  for (const value of ACCEPTED) {
    it(`accepts ${value}`, () => {
      assert.equal(newPartId(value), value)
    })
  }

  for (const value of REJECTED) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      assert.equal(newPartId(value), undefined)
    })
  }
})
