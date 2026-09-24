import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  DEFAULT_CLASSIFIER_MODEL,
  isSafePermissionProbability,
  newSafeProbability,
  SAFE_PERMISSION_THRESHOLD,
} from "./permissionDecision.ts"

describe("Jev permission decisions", () => {
  it("defaults to Jev on OpenRouter", () => {
    assert.equal(DEFAULT_CLASSIFIER_MODEL, "typesafe/jev-1.13")
  })

  it("reads a valid safe probability", () => {
    assert.equal(
      newSafeProbability({
        answers: { safe: { type: "noul", noul: 0.82 } },
      }),
      0.82,
    )
  })

  const invalidResponses: unknown[] = [
    null,
    "safe",
    {},
    { answers: [] },
    { answers: { safe: "yes" } },
    { answers: { safe: { type: "choice", noul: 0.99 } } },
    { answers: { safe: { type: "noul", noul: Number.NaN } } },
    { answers: { safe: { type: "noul", noul: -0.01 } } },
    { answers: { safe: { type: "noul", noul: 1.01 } } },
  ]

  for (const response of invalidResponses) {
    it(`rejects an invalid response ${JSON.stringify(response)}`, () => {
      assert.equal(newSafeProbability(response), undefined)
    })
  }

  it("allows at the confidence threshold", () => {
    assert.equal(SAFE_PERMISSION_THRESHOLD, 0.8)
    assert.equal(isSafePermissionProbability(0.8), true)
    assert.equal(isSafePermissionProbability(0.799), false)
  })

  it("keeps unknown probabilities on the prompt path", () => {
    assert.equal(isSafePermissionProbability(undefined), false)
    assert.equal(isSafePermissionProbability(Number.NaN), false)
    assert.equal(isSafePermissionProbability(1.01), false)
  })
})
