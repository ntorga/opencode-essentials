import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { newOpenRouterApiKey } from "./openRouterApiKey.ts"

describe("newOpenRouterApiKey", () => {
  it("trims a non-empty key", () => {
    assert.equal(newOpenRouterApiKey(" key-value "), "key-value")
  })

  it("rejects missing, blank, oversized, and control-character values", () => {
    assert.equal(newOpenRouterApiKey(undefined), undefined)
    assert.equal(newOpenRouterApiKey("  "), undefined)
    assert.equal(newOpenRouterApiKey(`key${"x".repeat(512)}`), undefined)
    assert.equal(newOpenRouterApiKey("key\nvalue"), undefined)
  })
})
