import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { newAbsolutePath } from "./absolutePath.ts"

describe("newAbsolutePath", () => {
  const accepted: unknown[] = ["/data", "/home/user/.local/share"]

  for (const candidate of accepted) {
    it(`accepts ${candidate}`, () => {
      assert.equal(newAbsolutePath(candidate), candidate)
    })
  }

  const rejected: unknown[] = ["relative/dir", "", " ", undefined, null, 7]

  for (const candidate of rejected) {
    it(`rejects ${JSON.stringify(candidate)}`, () => {
      assert.equal(newAbsolutePath(candidate), undefined)
    })
  }
})
