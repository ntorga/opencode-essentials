import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { newOpenRouterApiKey } from "../valueObject/openRouterApiKey.ts"
import type { PermissionName } from "../valueObject/permissionName.ts"
import { newPermissionName } from "../valueObject/permissionName.ts"
import {
  classifierQuestion,
  DEFAULT_CLASSIFIER_MODEL,
  isReasoningLoopProbability,
  isSafePermissionProbability,
  newDecisionProbability,
  REASONING_LOOP_CONFIRM_PROBABILITY,
  REASONING_LOOP_QUESTION,
  requestDecisionProbability,
  SAFE_PERMISSION_THRESHOLD,
} from "./permissionDecision.ts"

function trustedPermissionName(name: string): PermissionName {
  const validated = newPermissionName(name)
  if (!validated) throw new Error(`TestFixturePermissionInvalid: ${name}`)
  return validated
}

describe("Jev permission decisions", () => {
  it("defaults to Jev on OpenRouter", () => {
    assert.equal(DEFAULT_CLASSIFIER_MODEL, "typesafe/jev-1.13")
  })

  it("reads a valid safe probability", () => {
    assert.equal(
      newDecisionProbability(
        { answers: { safe: { type: "noul", noul: 0.82 } } },
        "safe",
      ),
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
      assert.equal(newDecisionProbability(response, "safe"), undefined)
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

describe("classifier questions", () => {
  it("asks a per-permission question under the matching state key", () => {
    assert.equal(
      classifierQuestion(trustedPermissionName("bash")).stateKey,
      "commands",
    )
    const edit = classifierQuestion(trustedPermissionName("edit"))
    assert.equal(edit.stateKey, "items")
    assert.match(edit.instructions, /file path/i)
    assert.equal(
      classifierQuestion(trustedPermissionName("external_directory")).stateKey,
      "items",
    )
  })

  const genericPermissions: string[] = [
    "webfetch",
    "constructor",
    "toString",
    "data_sync",
    "BASH",
  ]

  for (const name of genericPermissions) {
    it(`asks the generic question for ${name}`, () => {
      const question = classifierQuestion(trustedPermissionName(name))
      assert.equal(question.stateKey, "items")
      assert.match(question.instructions, new RegExp(name))
    })
  }

  it("confirms a reasoning spiral only at its own threshold", () => {
    assert.equal(REASONING_LOOP_CONFIRM_PROBABILITY, 0.8)
    assert.equal(isReasoningLoopProbability(0.8), true)
    assert.equal(isReasoningLoopProbability(0.799), false)
    assert.equal(isReasoningLoopProbability(undefined), false)
    assert.equal(isReasoningLoopProbability(-0.5), false)
  })

  it("asks the stuck question over the repeated-text sample", () => {
    assert.equal(REASONING_LOOP_QUESTION.stateKey, "items")
    assert.equal(REASONING_LOOP_QUESTION.answerKey, "stuck")
    assert.match(REASONING_LOOP_QUESTION.instructions, /reasoning spiral/i)
    assert.equal(
      newDecisionProbability(
        { answers: { stuck: { type: "noul", noul: 0.93 } } },
        "stuck",
      ),
      0.93,
    )
    assert.equal(
      newDecisionProbability(
        { answers: { safe: { type: "noul", noul: 0.93 } } },
        "stuck",
      ),
      undefined,
    )
  })

  it("sends the question instructions and patterns to the Decisions API", async () => {
    const edit = classifierQuestion(trustedPermissionName("edit"))
    const apiKey = newOpenRouterApiKey("sk-test")
    if (!apiKey) throw new Error("TestFixtureClassifierInputsMissing")
    const originalFetch = globalThis.fetch
    let sentBody:
      | {
          state: unknown
          questions: { safe: { instructions: string } }
        }
      | undefined
    globalThis.fetch = async (_url, init) => {
      sentBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({ answers: { safe: { type: "noul", noul: 0.9 } } }),
        { status: 200 },
      )
    }
    try {
      const probability = await requestDecisionProbability({
        apiKey,
        model: DEFAULT_CLASSIFIER_MODEL,
        question: edit,
        patterns: ["src/index.ts"],
        signal: new AbortController().signal,
      })
      assert.equal(probability, 0.9)
      if (!sentBody) throw new Error("TestFixtureRequestBodyMissing")
      assert.deepEqual(sentBody.state, { items: ["src/index.ts"] })
      assert.equal(sentBody.questions.safe.instructions, edit.instructions)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
