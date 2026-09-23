import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  clampCeilingToModel,
  resolveCeilingTurn,
  resolveProviderContextLimit,
} from "./contextCeiling.ts"
import type { ContextTokens } from "./valueObject/contextTokens.ts"
import { newModelId } from "./valueObject/modelId.ts"
import { newProviderId } from "./valueObject/providerId.ts"

function assistantTurn(
  input: {
    tokens?: unknown
    unfinished?: boolean
    summary?: boolean
    providerID?: string
    modelID?: string
  } = {},
) {
  const info: Record<string, unknown> = {
    role: "assistant",
    providerID: input.providerID ?? "anthropic",
    modelID: input.modelID ?? "claude-x",
    time: input.unfinished ? { created: 1 } : { created: 1, completed: 5 },
  }
  if (input.tokens !== undefined) info.tokens = input.tokens
  if (input.summary !== undefined) info.summary = input.summary
  return { info }
}

function fullTokens(
  input: number,
  output: number,
  read: number,
  write: number,
) {
  return { input, output, reasoning: 9, cache: { read, write } }
}

describe("resolveCeilingTurn", () => {
  it("returns undefined for non-arrays and empty transcripts", () => {
    assert.equal(resolveCeilingTurn(undefined), undefined)
    assert.equal(resolveCeilingTurn("nope"), undefined)
    assert.equal(resolveCeilingTurn([]), undefined)
  })

  it("measures the newest completed assistant turn and its model", () => {
    const turn = resolveCeilingTurn([
      { info: { role: "user" } },
      assistantTurn({ tokens: fullTokens(1000, 200, 30000, 10) }),
    ])
    assert.equal(turn?.usageTokens, 31210)
    assert.equal(turn?.model.providerId, "anthropic")
    assert.equal(turn?.model.modelId, "claude-x")
  })

  it("ignores user turns, unfinished assistants, and summary turns", () => {
    const turn = resolveCeilingTurn([
      assistantTurn({ tokens: fullTokens(1, 1, 1, 1) }),
      assistantTurn({ unfinished: true, tokens: fullTokens(9, 9, 9, 9) }),
      { info: { role: "user", time: {} } },
      assistantTurn({ summary: true }),
    ])
    assert.equal(turn?.usageTokens, 4)
  })

  it("abandons the check when the newest assistant has no usable model", () => {
    const turn = resolveCeilingTurn([
      assistantTurn({ tokens: fullTokens(5, 5, 5, 5) }),
      assistantTurn({ providerID: "", tokens: fullTokens(1, 1, 1, 1) }),
    ])
    assert.equal(turn, undefined)
  })

  it("abandons the check when the newest assistant tokens are not finite", () => {
    const turn = resolveCeilingTurn([
      assistantTurn({ tokens: { input: Number.NaN, cache: {} } }),
    ])
    assert.equal(turn, undefined)
  })

  it("abandons the check when the newest assistant has no tokens record", () => {
    const turn = resolveCeilingTurn([assistantTurn({ tokens: undefined })])
    assert.equal(turn, undefined)
  })

  it("abandons the check when the token sum overflows to infinity", () => {
    const turn = resolveCeilingTurn([
      assistantTurn({
        tokens: {
          input: Number.MAX_VALUE,
          output: Number.MAX_VALUE,
          cache: { read: 0, write: 0 },
        },
      }),
    ])
    assert.equal(turn, undefined)
  })

  it("abandons the check when a token component is negative", () => {
    const turn = resolveCeilingTurn([
      assistantTurn({
        tokens: { input: -5, output: 9000, cache: { read: 0, write: 0 } },
      }),
    ])
    assert.equal(turn, undefined)
  })

  it("skips malformed entries without info", () => {
    const turn = resolveCeilingTurn([
      null,
      "junk",
      { info: "not a record" },
      assistantTurn({ tokens: fullTokens(2, 2, 2, 2) }),
    ])
    assert.equal(turn?.usageTokens, 8)
  })
})

describe("resolveProviderContextLimit", () => {
  const providerList = {
    all: [
      {
        id: "anthropic",
        models: { "claude-x": { limit: { context: 200000 } } },
      },
      { id: "openai", models: { "gpt-y": { limit: { context: 1_047_152 } } } },
    ],
  }

  const openai = newProviderId("openai")
  assert.ok(openai)
  const google = newProviderId("google")
  assert.ok(google)
  const gptY = newModelId("gpt-y")
  assert.ok(gptY)
  const missingModel = newModelId("missing")
  assert.ok(missingModel)

  it("finds the limit by provider and model id", () => {
    assert.equal(
      resolveProviderContextLimit(providerList, openai, gptY),
      1_047_152,
    )
  })

  it("returns undefined when provider or model is absent", () => {
    assert.equal(
      resolveProviderContextLimit(providerList, google, gptY),
      undefined,
    )
    assert.equal(
      resolveProviderContextLimit(providerList, openai, missingModel),
      undefined,
    )
  })

  it("returns undefined for malformed provider payloads", () => {
    assert.equal(
      resolveProviderContextLimit(undefined, openai, gptY),
      undefined,
    )
    assert.equal(
      resolveProviderContextLimit({ all: "no" }, openai, gptY),
      undefined,
    )
    const broken = {
      all: [{ id: "openai", models: { "gpt-y": { limit: { context: NaN } } } }],
    }
    assert.equal(resolveProviderContextLimit(broken, openai, gptY), undefined)
  })
})

describe("clampCeilingToModel", () => {
  const requested = 384_000 as ContextTokens

  it("keeps the requested ceiling when the window is unknown or zero", () => {
    assert.deepEqual(clampCeilingToModel(requested, undefined), {
      ceiling: requested,
    })
    assert.deepEqual(clampCeilingToModel(requested, 0), { ceiling: requested })
    assert.deepEqual(clampCeilingToModel(requested, -10), {
      ceiling: requested,
    })
  })

  it("treats an implausibly small window as corrupt, not as a tiny model", () => {
    assert.deepEqual(clampCeilingToModel(requested, 100), {
      ceiling: requested,
    })
  })

  it("keeps the requested ceiling when the window covers it", () => {
    assert.deepEqual(clampCeilingToModel(requested, 1_000_000), {
      ceiling: requested,
    })
    assert.deepEqual(clampCeilingToModel(requested, 384_000), {
      ceiling: requested,
    })
  })

  it("clamps to the smaller model window and reports the source", () => {
    assert.deepEqual(clampCeilingToModel(requested, 200_000), {
      ceiling: 200_000,
      clampedFrom: requested,
    })
  })

  it("floors a fractional window before clamping", () => {
    assert.deepEqual(clampCeilingToModel(requested, 128_000.9), {
      ceiling: 128_000,
      clampedFrom: requested,
    })
  })
})
