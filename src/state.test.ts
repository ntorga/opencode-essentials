import { describe, it, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync, mkdirSync, mkdtempSync,
  readdirSync, rmSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  isFeatureEnabled,
  readFeatureStates,
  resolveEssentialsStatePath,
  writeFeatureEnabled,
} from "./state.ts"

// Note: Setup/teardown are intentionally inline — test independence
// requires each file to own its preconditions, even if it duplicates code.

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
    assert.deepEqual(read.states, {})
    assert.equal(isFeatureEnabled(read.states, "any-feature"), true)
  })

  it("round-trips toggles through the file", () => {
    writeFeatureEnabled("idle-auto-compactor", false)
    writeFeatureEnabled("exec-guard", true)
    const states = readFeatureStates().states
    assert.equal(states["idle-auto-compactor"], false)
    assert.equal(states["exec-guard"], true)
    assert.equal(isFeatureEnabled(states, "idle-auto-compactor"), false)
  })

  it("merges with existing entries", () => {
    writeFeatureEnabled("first", false)
    writeFeatureEnabled("second", false)
    writeFeatureEnabled("first", true)
    assert.deepEqual(readFeatureStates().states, {
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
      assert.deepEqual(read.states, {})
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
    ["{}", {}],
  ]

  for (const [content, expected] of entryFilters) {
    it(`keeps only boolean entries from ${content}`, () => {
      mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
      writeFileSync(resolveEssentialsStatePath(), content)
      assert.deepEqual(readFeatureStates().states, expected)
    })
  }

  it("leaves no temporary file behind after a write", () => {
    writeFeatureEnabled("idle-auto-compactor", false)
    const leftovers = readdirSync(path.dirname(resolveEssentialsStatePath()))
      .filter((name) => name.endsWith(".tmp"))
    assert.deepEqual(leftovers, [])
  })
})
