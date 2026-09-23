import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { sanitizeText } from "./log.ts"

describe("sanitizeText", () => {
  it("replaces Unicode control characters with spaces", () => {
    assert.equal(sanitizeText("left\u0000\u0085\u007Fright"), "left   right")
  })
})
