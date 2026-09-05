import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { newSessionId } from "./sessionId.ts"

describe("SessionId", () => {
  const accepted: unknown[] = [
    "ses_f8dd1fb5bffeSwU7gCdfKt7btW",
    "s1",
    "a".repeat(128),
  ]

  for (const candidate of accepted) {
    it(`accepts ${candidate}`, () => {
      assert.equal(newSessionId(candidate), candidate)
    })
  }

  const rejected: unknown[] = [
    undefined,
    null,
    7,
    {},
    [],
    "",
    "with space",
    "..",
    "../etc",
    "ses/../other",
    "a/b",
    "é",
    "a".repeat(129),
  ]

  for (const candidate of rejected) {
    it(`rejects ${JSON.stringify(candidate)}`, () => {
      assert.equal(newSessionId(candidate), undefined)
    })
  }
})
