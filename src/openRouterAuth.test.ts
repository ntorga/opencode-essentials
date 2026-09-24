import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { readOpenRouterApiKey } from "./openRouterAuth.ts"
import { resolveEssentialsStatePath } from "./state.ts"

let dataHomeTemp = ""
let previousDataHome: string | undefined

beforeEach(() => {
  previousDataHome = process.env.XDG_DATA_HOME
  dataHomeTemp = mkdtempSync(path.join(tmpdir(), "essentials-auth-test-"))
  process.env.XDG_DATA_HOME = dataHomeTemp
})

afterEach(() => {
  process.env.XDG_DATA_HOME = previousDataHome ?? ""
  rmSync(dataHomeTemp, { recursive: true, force: true })
})

function writeAuthDocument(document: unknown): void {
  const authFilePath = path.join(
    path.dirname(resolveEssentialsStatePath()),
    "auth.json",
  )
  mkdirSync(path.dirname(authFilePath), { recursive: true })
  writeFileSync(authFilePath, JSON.stringify(document))
}

describe("readOpenRouterApiKey", () => {
  it("uses the environment key when the auth store does not exist", () => {
    const credential = readOpenRouterApiKey("environment-key")

    assert.equal(credential.apiKey, "environment-key")
    assert.equal(credential.error, undefined)
  })

  it("prefers the OpenRouter key stored by OpenCode", () => {
    writeAuthDocument({
      openrouter: { type: "api", key: "stored-key" },
    })

    const credential = readOpenRouterApiKey("environment-key")

    assert.equal(credential.apiKey, "stored-key")
    assert.equal(credential.error, undefined)
  })

  it("uses the environment key when the auth store has no OpenRouter entry", () => {
    writeAuthDocument({ anthropic: { type: "api", key: "other-key" } })

    const credential = readOpenRouterApiKey("environment-key")

    assert.equal(credential.apiKey, "environment-key")
    assert.equal(credential.error, undefined)
  })

  it("uses the environment key when the auth file is invalid", () => {
    const authFilePath = path.join(
      path.dirname(resolveEssentialsStatePath()),
      "auth.json",
    )
    mkdirSync(path.dirname(authFilePath), { recursive: true })
    writeFileSync(authFilePath, "not json")

    const credential = readOpenRouterApiKey("environment-key")

    assert.equal(credential.apiKey, "environment-key")
    assert.equal(credential.error, "OpenCodeAuthStoreInvalidJson")
  })

  it("rejects a malformed OpenRouter entry", () => {
    writeAuthDocument({ openrouter: { type: "oauth", key: "wrong-type" } })

    const credential = readOpenRouterApiKey(undefined)

    assert.equal(credential.apiKey, undefined)
    assert.equal(credential.error, "OpenRouterAuthEntryInvalid")
  })
})
