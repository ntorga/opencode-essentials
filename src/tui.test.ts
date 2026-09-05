import { describe, it, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import {
  readFeatureStates,
  resolveEssentialsStatePath,
} from "./state.ts"
import { FEATURES } from "./features/registry.ts"
import tuiEntry from "./tui.ts"

// Note: Setup/teardown are intentionally inline — test independence
// requires each file to own its preconditions, even if it duplicates code.

type DialogProps = {
  title: string
  options: Array<{ title: string; value: string; footer: string }>
  onSelect: (item: { value: string }) => void
}

function fakeTuiApi() {
  const registeredCommands: Array<{
    name: string
    slashName?: unknown
    run: () => void
  }> = []
  const openedDialogs: DialogProps[] = []
  const toastMessages: string[] = []

  const api = {
    keymap: {
      registerLayer: (layer: {
        commands: typeof registeredCommands
      }) => {
        registeredCommands.push(...layer.commands)
      },
    },
    tuiConfig: { keybinds: { gather: () => [] } },
    ui: {
      dialog: {
        replace: (render: () => unknown) => {
          openedDialogs.push(render() as DialogProps)
        },
      },
      DialogSelect: (props: unknown) => props,
      toast: (input: { message: string }) => {
        toastMessages.push(input.message)
      },
    },
  }

  return {
    api: api as unknown as TuiPluginApi,
    registeredCommands,
    openedDialogs,
    toastMessages,
  }
}

let dataHomeTemp = ""
let previousDataHome: string | undefined

beforeEach(() => {
  previousDataHome = process.env["XDG_DATA_HOME"]
  dataHomeTemp = mkdtempSync(path.join(tmpdir(), "essentials-test-"))
  process.env["XDG_DATA_HOME"] = dataHomeTemp
})

afterEach(() => {
  // "" and unset behave the same: resolveEssentialsStatePath falls back to
  // ~/.local/share for both.
  process.env["XDG_DATA_HOME"] = previousDataHome ?? ""
  rmSync(dataHomeTemp, { recursive: true, force: true })
})

describe("essentials tui companion", () => {
  it("exports an id and a tui plugin function", () => {
    assert.equal(typeof tuiEntry.id, "string")
    assert.equal(typeof tuiEntry.tui, "function")
  })

  it("registers a palette command", async () => {
    const fake = fakeTuiApi()
    await tuiEntry.tui(fake.api, undefined, { id: "test" } as never)

    assert.deepEqual(
      fake.registeredCommands.map((command) => command.name),
      ["essentials.features"],
    )
  })

  it("maps the command to /essentials", async () => {
    const fake = fakeTuiApi()
    await tuiEntry.tui(fake.api, undefined, { id: "test" } as never)

    assert.equal(
      fake.registeredCommands[0]?.slashName,
      "essentials",
    )
  })

  it("lists every feature with its current state", async () => {
    const fake = fakeTuiApi()
    await tuiEntry.tui(fake.api, undefined, { id: "test" } as never)
    fake.registeredCommands[0]?.run()

    const dialog = fake.openedDialogs[0]
    assert.ok(dialog)
    assert.equal(dialog.title, "OpenCode Essentials")
    assert.deepEqual(
      dialog.options.map((option) => option.value),
      FEATURES.map((feature) => feature.id),
    )
    assert.ok(dialog.options.every((option) => option.footer === "enabled"))
  })

  it("flips the state file, toasts, and re-renders on select", async () => {
    const fake = fakeTuiApi()
    await tuiEntry.tui(fake.api, undefined, { id: "test" } as never)
    const featureId = FEATURES[0].id

    fake.registeredCommands[0]?.run()
    fake.openedDialogs[0]?.onSelect({ value: featureId })

    assert.equal(readFeatureStates().states[featureId], false)
    assert.equal(fake.toastMessages.length, 1)
    assert.match(fake.toastMessages[0], /disabled$/)

    const reopened = fake.openedDialogs[1]
    assert.ok(reopened)
    const flipped = reopened.options.find((option) => option.value === featureId)
    assert.equal(flipped?.footer, "disabled")

    reopened.onSelect({ value: featureId })
    assert.equal(readFeatureStates().states[featureId], true)
    assert.match(fake.toastMessages[1], /enabled$/)
  })

  it("ignores selects for unknown feature ids", async () => {
    const fake = fakeTuiApi()
    await tuiEntry.tui(fake.api, undefined, { id: "test" } as never)

    fake.registeredCommands[0]?.run()
    fake.openedDialogs[0]?.onSelect({ value: "not-a-feature" })

    assert.equal(fake.toastMessages.length, 0)
    assert.equal(fake.openedDialogs.length, 1)
  })

  it("toasts a write failure and leaves the dialog closed", async () => {
    mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
    writeFileSync(resolveEssentialsStatePath(), "not json {{{")
    const fake = fakeTuiApi()
    await tuiEntry.tui(fake.api, undefined, { id: "test" } as never)

    fake.registeredCommands[0]?.run()
    const opened = fake.openedDialogs.length
    fake.openedDialogs[0]?.onSelect({ value: FEATURES[0].id })

    assert.ok(
      fake.toastMessages.some((message) =>
        message.startsWith("FeatureToggleWriteFailed"),
      ),
    )
    assert.equal(fake.openedDialogs.length, opened)
  })

  it("warns when the state file cannot be read", async () => {
    mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
    writeFileSync(resolveEssentialsStatePath(), "not json {{{")
    const fake = fakeTuiApi()
    await tuiEntry.tui(fake.api, undefined, { id: "test" } as never)

    fake.registeredCommands[0]?.run()

    assert.ok(
      fake.toastMessages.some((message) =>
        message.startsWith("FeatureStatesReadFailed"),
      ),
    )
    assert.equal(fake.openedDialogs.length, 1)
  })
})
