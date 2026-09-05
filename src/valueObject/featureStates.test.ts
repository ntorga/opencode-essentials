import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { newFeatureStates } from "./featureStates.ts"

describe("FeatureStates", () => {
  const cases: Array<[string, Record<string, boolean>]> = [
    ['{"good": false, "stringy": "yes", "count": 3}', { good: false }],
    ['{"with space": true, "good": true}', { good: true }],
    ['{"..": true, "good": false}', { good: false }],
    ["{}", {}],
  ]

  for (const [content, expected] of cases) {
    it(`keeps only shaped boolean entries from ${content}`, () => {
      const parsed = JSON.parse(content)
      assert.deepEqual({ ...newFeatureStates(parsed) }, expected)
    })
  }

  it("rejects non-object shapes", () => {
    assert.equal(newFeatureStates("[1, 2]"), undefined)
    assert.equal(newFeatureStates('"hello"'), undefined)
    assert.equal(newFeatureStates(null), undefined)
  })

  it("keeps a dotted feature id", () => {
    const states = newFeatureStates({ "exec.guard": false })
    assert.deepEqual({ ...states }, { "exec.guard": false })
  })
})
