import { describe, it, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FeatureId } from "./valueObject/featureId.ts"
import { newFeatureId } from "./valueObject/featureId.ts"
import {
  isFeatureEnabled,
  readFeatureStates,
  resolveEssentialsStatePath,
  writeFeatureEnabled,
} from "./state.ts"

// Note: Setup/teardown are intentionally inline — test independence
// requires each file to own its preconditions, even if it duplicates code.

function trustedFeatureId(id: string): FeatureId {
  const validated = newFeatureId(id)
  if (!validated) throw new Error(`test fixture id is invalid: ${id}`)
  return validated
}

let dataHomeTemp = ""
let previousDataHome: string | undefined

beforeEach(() => {
  previousDataHome = process.env["XDG_DATA_HOME"]
  dataHomeTemp = mkdtempSync(path.join(tmpdir(), "essentials-state-"))
  process.env["XDG_DATA_HOME"] = dataHomeTemp
})

afterEach(() => {
  // "" and unset behave the same: resolveEssentialsStatePath falls back to
  // ~/.local/share for both.
  process.env["XDG_DATA_HOME"] = previousDataHome ?? ""
  rmSync(dataHomeTemp, { recursive: true, force: true })
})

describe("essentials state file", () => {
  it("returns defaults with no error when no file exists", () => {
    const read = readFeatureStates()
    assert.equal(read.error, undefined)
    assert.deepEqual({ ...read.states }, {})
    assert.equal(
      isFeatureEnabled(read.states, trustedFeatureId("any-feature")),
      true,
    )
  })

  it("round-trips toggles through the file", () => {
    writeFeatureEnabled(trustedFeatureId("idle-auto-compactor"), false)
    writeFeatureEnabled(trustedFeatureId("exec-guard"), true)
    const states = readFeatureStates().states
    assert.equal(
      states[trustedFeatureId("idle-auto-compactor")],
      false,
    )
    assert.equal(states[trustedFeatureId("exec-guard")], true)
    assert.equal(
      isFeatureEnabled(states, trustedFeatureId("idle-auto-compactor")),
      false,
    )
  })

  it("merges with existing entries", () => {
    writeFeatureEnabled(trustedFeatureId("first"), false)
    writeFeatureEnabled(trustedFeatureId("second"), false)
    writeFeatureEnabled(trustedFeatureId("first"), true)
    assert.deepEqual({ ...readFeatureStates().states }, {
      first: true,
      second: false,
    })
  })

  const unreadableContents: Array<[string, string]> = [
    ["corrupt text", "not json {{{"],
    ["an array", "[1, 2]"],
    ["a bare string", '"hello"'],
  ]

  for (const [label, content] of unreadableContents) {
    it(`reports an error when the file holds ${label}`, () => {
      mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
      writeFileSync(resolveEssentialsStatePath(), content)
      const read = readFeatureStates()
      assert.ok(read.error)
      assert.deepEqual({ ...read.states }, {})
    })
  }

  it("reports an error when the file is unreadable", () => {
    mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
    writeFileSync(resolveEssentialsStatePath(), '{"idle-auto-compactor": false}')
    chmodSync(resolveEssentialsStatePath(), 0o000)
    const read = readFeatureStates()
    chmodSync(resolveEssentialsStatePath(), 0o644)
    assert.ok(read.error)
  })

  const entryFilters: Array<[string, Record<string, boolean>]> = [
    ['{"good": false, "stringy": "yes", "count": 3}', { good: false }],
    ['{"only": true}', { only: true }],
    ['{"with space": true, "good": true}', { good: true }],
    ["{}", {}],
  ]

  for (const [content, expected] of entryFilters) {
    it(`keeps only boolean entries from ${content}`, () => {
      mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
      writeFileSync(resolveEssentialsStatePath(), content)
      assert.deepEqual({ ...readFeatureStates().states }, expected)
    })
  }

  it("leaves no temporary file behind after a write", () => {
    writeFeatureEnabled(trustedFeatureId("idle-auto-compactor"), false)
    const leftovers = readdirSync(path.dirname(resolveEssentialsStatePath()))
      .filter((name) => name.endsWith(".tmp"))
    assert.deepEqual(leftovers, [])
  })

  it("refuses to overwrite a corrupt state file", () => {
    mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
    writeFileSync(resolveEssentialsStatePath(), "not json {{{")
    assert.throws(() =>
      writeFeatureEnabled(trustedFeatureId("idle-auto-compactor"), true),
    )
    assert.equal(
      readFileSync(resolveEssentialsStatePath(), "utf8"),
      "not json {{{",
    )
  })

  it("reports an error when the state path is a directory", () => {
    mkdirSync(resolveEssentialsStatePath(), { recursive: true })
    const read = readFeatureStates()
    assert.ok(read.error)
    assert.deepEqual({ ...read.states }, {})
  })

  it("reports an error when the state file is oversized", () => {
    mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
    writeFileSync(
      resolveEssentialsStatePath(),
      JSON.stringify({ padding: "x".repeat(70 * 1024) }),
    )
    assert.ok(readFeatureStates().error)
  })

  it("reports an error when the state directory is writable by others", () => {
    mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
    chmodSync(path.dirname(resolveEssentialsStatePath()), 0o777)
    try {
      assert.ok(readFeatureStates().error)
    } finally {
      chmodSync(path.dirname(resolveEssentialsStatePath()), 0o700)
    }
  })
})
