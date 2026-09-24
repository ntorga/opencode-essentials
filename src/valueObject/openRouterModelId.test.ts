import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { newOpenRouterModelId } from "./openRouterModelId.ts"

describe("OpenRouterModelId", () => {
  for (const candidate of ["typesafe/jev-1.13", "openrouter/auto"]) {
    it(`accepts ${candidate}`, () => {
      assert.equal(newOpenRouterModelId(candidate), candidate)
    })
  }

  for (const candidate of [
    undefined,
    "model",
    "/model",
    "provider/",
    "provider/model/variant",
    "provider/model with spaces",
  ]) {
    it(`rejects ${JSON.stringify(candidate)}`, () => {
      assert.equal(newOpenRouterModelId(candidate), undefined)
    })
  }
})
