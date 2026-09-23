import assert from "node:assert/strict"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import type { PluginInput } from "@opencode-ai/plugin"
import execWrapperGuard from "./exec-wrapper-guard.ts"

const permissionFixture = {
  agent: {
    build: {
      permission: {
        bash: {
          "*": "allow",
          "git push *": "ask",
          "git push --force *": "deny",
        },
      },
    },
    reviewer: {
      permission: {
        bash: {
          "*": "ask",
          "git worktree *": "deny",
        },
      },
    },
  },
}

describe("exec-wrapper-guard", () => {
  it("checks every natural wrapper and nested shell segment", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "exec-wrapper-test-"))
    const configPath = path.join(directory, "opencode.json")
    const loggedMessages: string[] = []
    writeFileSync(configPath, JSON.stringify(permissionFixture))

    const fakeInput = {
      worktree: directory,
      client: {
        app: {
          log: async (request: { body: { message: string } }) => {
            loggedMessages.push(request.body.message)
          },
        },
      },
    } as unknown as PluginInput
    const hooks = await execWrapperGuard(fakeInput)
    const execute = hooks["tool.execute.before"]
    assert.ok(execute)
    const cases: Array<[string, string, "deny" | "ask" | "allow"]> = [
      ["build", "timeout 5 git worktree list", "deny"],
      ["build", "timeout --preserve-status 5 git worktree list", "deny"],
      ["build", "FOO=1 timeout 5 git worktree list", "deny"],
      ["build", "nohup git worktree list", "deny"],
      ["build", "nice -n 5 git worktree list", "deny"],
      ["build", "stdbuf -oL git worktree list", "deny"],
      ["build", "setsid --wait git worktree list", "deny"],
      ["build", "sh -c 'git worktree list'", "deny"],
      ["build", 'bash -c "git status && git worktree list"', "deny"],
      ["build", "zsh -c 'git worktree list'", "deny"],
      ["build", "mise exec -- git worktree list", "deny"],
      ["build", "mise x -- git worktree list", "deny"],
      ["build", "direnv exec . git worktree list", "deny"],
      [
        "build",
        'timeout 5 env FOO=1 bash -c "git push --force origin main"',
        "deny",
      ],
      ["build", "timeout 5 git push origin main", "ask"],
      ["build", "timeout 5 git push", "ask"],
      ["build", "timeout 5 date", "allow"],
      ["build", "time git worktree list", "allow"],
      ["build", "FOO=1 git worktree list", "allow"],
      ["build", "env FOO=1 git status", "allow"],
    ]

    try {
      for (const [profile, command, expected] of cases) {
        const executeCommand = () =>
          execute(
            { tool: "bash", sessionID: profile, callID: command },
            { args: { command } },
          )

        if (expected === "deny") {
          await assert.rejects(executeCommand, /Blocked wrapped command/)
          continue
        }
        if (expected === "ask") {
          const innerCommand = command.endsWith("git push")
            ? "git push"
            : "git push origin main"
          await assert.rejects(executeCommand, (failure: unknown) => {
            assert.ok(failure instanceof Error)
            assert.equal(
              failure.message,
              `run this unwrapped so the human is prompted: ${innerCommand}`,
            )
            return true
          })
          continue
        }
        await executeCommand()
      }
      assert.deepEqual(loggedMessages, [])
    } finally {
      await hooks.dispose?.()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("fails open when bash parsing fails and logs a warning", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "exec-wrapper-test-"))
    writeFileSync(
      path.join(directory, "opencode.json"),
      JSON.stringify(permissionFixture),
    )
    const loggedEntries: Array<{ level: string; message: string }> = []
    const fakeInput = {
      worktree: directory,
      client: {
        app: {
          log: async (request: {
            body: { level: string; message: string }
          }) => {
            loggedEntries.push({
              level: request.body.level,
              message: request.body.message,
            })
          },
        },
      },
    } as unknown as PluginInput
    const hooks = await execWrapperGuard(fakeInput)

    try {
      const execute = hooks["tool.execute.before"]
      assert.ok(execute)
      await execute(
        { tool: "bash", sessionID: "s1", callID: "c1" },
        { args: { command: 'timeout 5 bash -c "git push' } },
      )
      assert.deepEqual(loggedEntries, [
        { level: "warn", message: "ExecWrapperEvaluationFailed" },
      ])
    } finally {
      await hooks.dispose?.()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("fails open for a runtime-expanded command name and logs a warning", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "exec-wrapper-test-"))
    writeFileSync(
      path.join(directory, "opencode.json"),
      JSON.stringify(permissionFixture),
    )
    const loggedMessages: string[] = []
    const fakeInput = {
      worktree: directory,
      client: {
        app: {
          log: async (request: { body: { message: string } }) => {
            loggedMessages.push(request.body.message)
          },
        },
      },
    } as unknown as PluginInput
    const hooks = await execWrapperGuard(fakeInput)

    try {
      const execute = hooks["tool.execute.before"]
      assert.ok(execute)
      await execute(
        { tool: "bash", sessionID: "s1", callID: "c1" },
        { args: { command: 'timeout 5 "$RUN_COMMAND"' } },
      )
      assert.deepEqual(loggedMessages, ["ExecWrapperEvaluationFailed"])
    } finally {
      await hooks.dispose?.()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("ignores non-bash tools", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "exec-wrapper-test-"))
    writeFileSync(
      path.join(directory, "opencode.json"),
      JSON.stringify(permissionFixture),
    )
    const loggedMessages: string[] = []
    const fakeInput = {
      worktree: directory,
      client: {
        app: {
          log: async (request: { body: { message: string } }) => {
            loggedMessages.push(request.body.message)
          },
        },
      },
    } as unknown as PluginInput
    const hooks = await execWrapperGuard(fakeInput)

    try {
      const execute = hooks["tool.execute.before"]
      assert.ok(execute)
      await execute(
        { tool: "write", sessionID: "s1", callID: "c1" },
        { args: { command: "timeout 5 git worktree list" } },
      )
      assert.deepEqual(loggedMessages, [])
    } finally {
      await hooks.dispose?.()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("reloads permissions when opencode.json changes", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "exec-wrapper-test-"))
    const configPath = path.join(directory, "opencode.json")
    const loggedMessages: string[] = []
    writeFileSync(configPath, JSON.stringify(permissionFixture))
    const fakeInput = {
      worktree: directory,
      client: {
        app: {
          log: async (request: { body: { message: string } }) => {
            loggedMessages.push(request.body.message)
          },
        },
      },
    } as unknown as PluginInput
    const hooks = await execWrapperGuard(fakeInput)
    const execute = hooks["tool.execute.before"]
    assert.ok(execute)
    const toolInput = { tool: "bash", sessionID: "s1", callID: "c1" }
    const output = { args: { command: "timeout 5 git worktree list" } }

    try {
      await assert.rejects(
        execute(toolInput, output),
        /Blocked wrapped command/,
      )
      const updatedFixture = {
        agent: { build: { permission: { bash: { "*": "allow" } } } },
      }
      writeFileSync(configPath, JSON.stringify(updatedFixture))
      const changedAt = new Date(Date.now() + 2_000)
      utimesSync(configPath, changedAt, changedAt)
      await execute(toolInput, output)
      assert.deepEqual(loggedMessages, [])
    } finally {
      await hooks.dispose?.()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects ask rules with the unwrapped command", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "exec-wrapper-test-"))
    const askFixture = {
      agent: {
        build: {
          permission: {
            bash: { "*": "allow", "git pus? origin main": "ask" },
          },
        },
      },
    }
    writeFileSync(
      path.join(directory, "opencode.json"),
      JSON.stringify(askFixture),
    )
    const fakeInput = {
      worktree: directory,
      client: { app: { log: async () => undefined } },
    } as unknown as PluginInput
    const hooks = await execWrapperGuard(fakeInput)
    const execute = hooks["tool.execute.before"]
    assert.ok(execute)

    try {
      await assert.rejects(
        execute(
          { tool: "bash", sessionID: "s1", callID: "c1" },
          { args: { command: "timeout 5 git push origin main" } },
        ),
        (failure: unknown) => {
          assert.ok(failure instanceof Error)
          assert.equal(
            failure.message,
            "run this unwrapped so the human is prompted: git push origin main",
          )
          return true
        },
      )
    } finally {
      await hooks.dispose?.()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
