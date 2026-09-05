import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { newModelRef } from "./modelRef.ts"

describe("ModelRef", () => {
  it("builds a ref from two valid tokens", () => {
    assert.deepEqual(newModelRef({ providerID: "p", modelID: "a/b" }), {
      providerId: "p",
      modelId: "a/b",
    })
  })

  const rejected: unknown[] = [
    undefined,
    null,
    "provider/model",
    {},
    { providerID: "p" },
    { modelID: "m" },
    { providerID: "p", modelID: "bad id" },
    { providerID: "bad id", modelID: "m" },
  ]

  for (const candidate of rejected) {
    it(`rejects ${JSON.stringify(candidate)}`, () => {
      assert.equal(newModelRef(candidate), undefined)
    })
  }
})
