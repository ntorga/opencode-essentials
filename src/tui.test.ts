import { describe, it, afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { readEssentialsConfig, resolveEssentialsStatePath } from "./state.ts"
import { FEATURES } from "./features/registry.ts"
import tuiEntry from "./tui.ts"

// Note: Setup/teardown are intentionally inline — test independence
// requires each file to own its preconditions, even if it duplicates code.

type SelectProps = {
  title: string
  options: Array<{ title: string; value: unknown; footer: string }>
  onSelect: (option: { value: unknown }) => void
}

type PromptProps = {
  title: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

function fakeTuiApi() {
  const registeredCommands: Array<{
    name: string
    slashName?: unknown
    run: () => void
  }> = []
  const openedDialogs: SelectProps[] = []
  const openedPrompts: PromptProps[] = []
  const toastMessages: string[] = []

  const api = {
    keymap: {
      registerLayer: (layer: { commands: typeof registeredCommands }) => {
        registeredCommands.push(...layer.commands)
      },
    },
    tuiConfig: { keybinds: { gather: () => [] } },
    ui: {
      dialog: {
        replace: (render: () => unknown) => {
          openedDialogs.push(render() as SelectProps)
        },
      },
      DialogSelect: (props: unknown) => props,
      DialogPrompt: (props: unknown) => {
        openedPrompts.push(props as PromptProps)
        return props
      },
      toast: (input: { message: string }) => {
        toastMessages.push(input.message)
      },
    },
  }

  return {
    api: api as unknown as TuiPluginApi,
    registeredCommands,
    openedDialogs,
    openedPrompts,
    toastMessages,
  }
}

async function openMainDialog(fake: ReturnType<typeof fakeTuiApi>) {
  await tuiEntry.tui(fake.api, undefined, { id: "test" } as never)
  fake.registeredCommands[0]?.run()
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

  it("registers the /essentials palette command", async () => {
    const fake = fakeTuiApi()
    await tuiEntry.tui(fake.api, undefined, { id: "test" } as never)

    assert.deepEqual(
      fake.registeredCommands.map((command) => command.name),
      ["essentials.features"],
    )
    assert.equal(fake.registeredCommands[0]?.slashName, "essentials")
  })

  it("lists global, feature, and timeout rows", async () => {
    const fake = fakeTuiApi()
    await openMainDialog(fake)

    const dialog = fake.openedDialogs[0]
    assert.ok(dialog)
    assert.equal(dialog.title, "OpenCode Essentials")
    assert.deepEqual(
      dialog.options.map((option) => option.value),
      [
        "$global",
        ...FEATURES.map((feature) => feature.id),
        "$timeout:idle-auto-compactor",
      ],
    )
    assert.deepEqual(
      dialog.options.map((option) => option.footer),
      ["enabled", "enabled", "30 min (default)"],
    )
  })

  it("shows the master switch off and the choices kept when it flips", async () => {
    const fake = fakeTuiApi()
    await openMainDialog(fake)
    fake.openedDialogs[0]?.onSelect({ value: "$global" })

    const dialog = fake.openedDialogs[1]
    assert.equal(dialog?.options[0]?.footer, "disabled")
    assert.equal(dialog?.options[1]?.footer, "enabled")
    const config = readEssentialsConfig().config
    assert.equal(config.isEnabled, false)
    assert.deepEqual({ ...config.states }, {})
  })

  it("flips the feature flag, toasts, and re-renders on select", async () => {
    const fake = fakeTuiApi()
    await openMainDialog(fake)
    const featureId = FEATURES[0].id

    fake.openedDialogs[0]?.onSelect({ value: featureId })

    assert.equal(readEssentialsConfig().config.states[featureId], false)
    assert.equal(fake.toastMessages.length, 1)
    assert.match(fake.toastMessages[0] ?? "", /disabled/)
    assert.equal(fake.openedDialogs.length, 2)
  })

  it("opens the timeout submenu from the timeout row", async () => {
    const fake = fakeTuiApi()
    await openMainDialog(fake)

    fake.openedDialogs[0]?.onSelect({
      value: "$timeout:idle-auto-compactor",
    })

    const submenu = fake.openedDialogs[1]
    assert.ok(submenu)
    assert.match(submenu.title, /idle timeout/)
    assert.deepEqual(
      submenu.options.map((option) => option.value),
      [300_000, 900_000, 1_800_000, 3_600_000, "$custom"],
    )
    assert.deepEqual(
      submenu.options.map((option) => option.footer),
      ["", "", "", "", ""],
      "nothing is stored yet, so no row is marked",
    )
  })

  it("marks the stored preset and offers the default back", async () => {
    const fake = fakeTuiApi()
    await openMainDialog(fake)
    fake.openedDialogs[0]?.onSelect({
      value: "$timeout:idle-auto-compactor",
    })
    fake.openedDialogs[1]?.onSelect({ value: 900_000 })

    fake.openedDialogs[2]?.onSelect({
      value: "$timeout:idle-auto-compactor",
    })

    const submenu = fake.openedDialogs[3]
    assert.ok(submenu)
    assert.deepEqual(
      submenu.options.map((option) => option.value),
      [300_000, 900_000, 1_800_000, 3_600_000, "$custom", "$clear"],
    )
    assert.equal(submenu.options[1]?.footer, "stored")
  })

  it("writes a preset timeout and returns to the main dialog", async () => {
    const fake = fakeTuiApi()
    await openMainDialog(fake)
    fake.openedDialogs[0]?.onSelect({
      value: "$timeout:idle-auto-compactor",
    })

    fake.openedDialogs[1]?.onSelect({ value: 900_000 })

    const config = readEssentialsConfig().config
    assert.equal(config.timeouts[FEATURES[0].id], 900_000)
    assert.match(fake.toastMessages.join("|"), /15 min/)
    assert.equal(fake.openedDialogs[2]?.title, "OpenCode Essentials")
    assert.equal(
      fake.openedDialogs[2]?.options[2]?.footer,
      "15 min (stored)",
    )
  })

  it("keeps the 30 min default footer when nothing is configured", async () => {
    const fake = fakeTuiApi()
    await openMainDialog(fake)

    assert.equal(
      fake.openedDialogs[0]?.options[2]?.footer,
      "30 min (default)",
    )
  })

  it("labels a sub-minute timeout as under a minute", async () => {
    mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
    writeFileSync(
      resolveEssentialsStatePath(),
      JSON.stringify({
        version: 1,
        settings: { "idle-auto-compactor": { idleTimeoutMs: 3000 } },
      }),
    )
    const fake = fakeTuiApi()
    await openMainDialog(fake)

    assert.equal(
      fake.openedDialogs[0]?.options[2]?.footer,
      "under a minute (stored)",
    )
  })

  it("accepts a custom timeout from the prompt", async () => {
    const fake = fakeTuiApi()
    await openMainDialog(fake)
    fake.openedDialogs[0]?.onSelect({
      value: "$timeout:idle-auto-compactor",
    })
    fake.openedDialogs[1]?.onSelect({ value: "$custom" })

    const prompt = fake.openedPrompts[0]
    assert.ok(prompt)
    prompt.onConfirm("25")

    assert.equal(
      readEssentialsConfig().config.timeouts[FEATURES[0].id],
      1_500_000,
    )
  })

  const rejectedTimeoutInputs = ["banana", "0", "-5", "2.5", "1e300", ""]
  for (const rawInput of rejectedTimeoutInputs) {
    it(`rejects custom timeout "${rawInput}" and reopens the prompt`, async () => {
      const fake = fakeTuiApi()
      await openMainDialog(fake)
      fake.openedDialogs[0]?.onSelect({
        value: "$timeout:idle-auto-compactor",
      })
      fake.openedDialogs[1]?.onSelect({ value: "$custom" })

      fake.openedPrompts[0]?.onConfirm(rawInput)

      assert.match(
        fake.toastMessages.join("|"),
        /EssentialsIdleTimeoutRejected/,
      )
      assert.equal(fake.openedPrompts.length, 2)
      assert.deepEqual({ ...readEssentialsConfig().config.timeouts }, {})
    })
  }

  it("clears a stored timeout back to the default", async () => {
    const fake = fakeTuiApi()
    await openMainDialog(fake)
    fake.openedDialogs[0]?.onSelect({
      value: "$timeout:idle-auto-compactor",
    })
    fake.openedDialogs[1]?.onSelect({ value: 900_000 })
    fake.openedDialogs[2]?.onSelect({
      value: "$timeout:idle-auto-compactor",
    })

    fake.openedDialogs[3]?.onSelect({ value: "$clear" })

    assert.deepEqual({ ...readEssentialsConfig().config.timeouts }, {})
    assert.equal(
      fake.openedDialogs[4]?.options[2]?.footer,
      "30 min (default)",
    )
  })

  it("returns to the main dialog when the prompt is cancelled", async () => {
    const fake = fakeTuiApi()
    await openMainDialog(fake)
    fake.openedDialogs[0]?.onSelect({
      value: "$timeout:idle-auto-compactor",
    })
    fake.openedDialogs[1]?.onSelect({ value: "$custom" })

    fake.openedPrompts[0]?.onCancel()

    assert.equal(fake.openedDialogs.at(-1)?.title, "OpenCode Essentials")
  })

  it("toasts when a write fails and keeps the dialog open", async () => {
    const fake = fakeTuiApi()
    await openMainDialog(fake)
    mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
    writeFileSync(resolveEssentialsStatePath(), "not json {{{")

    fake.openedDialogs[0]?.onSelect({ value: FEATURES[0].id })

    assert.match(fake.toastMessages.join("|"), /EssentialsConfigWriteFailed/)
    assert.equal(fake.openedDialogs.length, 1)
  })

  it("warns with a toast when the config file is corrupt", async () => {
    mkdirSync(path.dirname(resolveEssentialsStatePath()), { recursive: true })
    writeFileSync(resolveEssentialsStatePath(), "not json {{{")
    const fake = fakeTuiApi()
    await openMainDialog(fake)

    assert.match(
      fake.toastMessages.join("|"),
      /EssentialsConfigReadFailed/,
    )
    assert.equal(fake.openedDialogs[0]?.options[0]?.footer, "enabled")
  })
})
