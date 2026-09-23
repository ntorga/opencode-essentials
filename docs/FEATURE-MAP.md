# Feature Map

> Auto-maintained index of every user-facing feature and the code path that implements it. Updated alongside the code — not after the fact.

## Idle Auto Compactor

Compacts an OpenCode session automatically after the session stays continuously idle for 30 minutes (configurable). The feature is event-driven and uses one-shot timers, never polling. It is feature 1 of the essentials plugin suite and can be toggled and tuned at runtime from the TUI.

**Flow:**

1. `src/server.ts` — server entry. Builds each feature's hooks from per-feature options and fans them out via `combineHooks`.
2. `src/features/registry.ts` — lists the `idle-auto-compactor` `SuiteFeature` for both entry points.
3. `src/features/idle-auto-compactor.ts` — the feature. Subscribes to `session.status` and `session.deleted`. An idle status arms a one-shot timer; a busy status cancels it; a genuine `chat.message` reopens the idle period. When the timer fires, it skips a last compaction and a newest real turn under 32,000 tokens. It summarizes with the measured turn's model. The state machine absorbs the compaction's own busy/idle echoes.
4. `src/state.ts` — the shared config protocol. The server reads `$XDG_DATA_HOME/opencode/essentials.json` at each decision point: the master switch gates the feature, and the file's timeout setting overrides the plugin option.
5. `src/valueObject/` — the trust boundary. Every external string and number (event session ids, model tokens, config timeouts, state-file keys, `XDG_DATA_HOME`) becomes a branded type through a `new*` constructor before use.
6. `src/tui.ts` — TUI companion, registered in `tui.json` (the TUI host does
   not read `opencode.json`). The `/essentials` command opens a
   `DialogSelect` with the master switch, the feature flags, and the
   idle-timeout submenu; every choice is written to the state file.
7. `src/README.md` — installation, configuration, and the exact semantics.

---

## Token Ceiling Compactor

Compacts a session once the newest finished turn's context usage passes a
chosen token ceiling — default 384k, selectable 128k to 1M — regardless of
the model. Small-context guard: the effective ceiling is the smaller of the
choice and the model's own context window. Feature 2 of the essentials
suite. It is a server feature; a `/essentials` row and picker control it at
runtime.

**Flow:**

1. `src/features/token-ceiling-compactor.ts` — on an idle
   `session.status` event, settles the period synchronously (the same
   settle-flag echo absorption the idle compactor uses), then reads
   messages and the provider list and decides.
2. `src/contextCeiling.ts` — pure logic: measure the newest real completed
   turn (usage tokens + model ref, skipping summary turns), read the model's
   context window from the provider list, clamp the ceiling to it.
3. `src/features/sessionSummarizer.ts` — the shared `session.summarize`
   request (deadline, error mapping); idle compaction stays manual, while
   token-ceiling compaction asks OpenCode to continue after its summary.
4. `src/valueObject/contextTokens.ts` — the validated token ceiling:
   presets 128k–1M, default 384k, hard max 2,000,000.
5. `src/state.ts` + `src/valueObject/essentialsConfig.ts` — the
   `ceilingTokens` settings entry in the shared state file; the
   `/essentials` submenu in `src/tui.ts` writes it.

---

## Idle Session Clock

Shows how long the open session has been idle — the time since the model
stopped answering and left the floor to the user — as one line at the bottom
of the TUI. It includes the local idle start date and time. It turns yellow
at half of the idle auto-compactor timeout and red at 80 percent. It is
feature 3 of the essentials suite and is toggled at runtime from the same
`/essentials` dialog.
It is a TUI-only feature: it has no server hooks.

**Flow:**

1. `src/idle-clock.tsx` — a second TUI entry, registered in `tui.json`. It
   registers a host `app_bottom` slot through `api.slots.register`. A 1-second
   Solid signal drives the tick. The TUI plugin option supplies the server's
   default idle timeout; a state-file timeout overrides it. The entry applies
   the shared timer ceiling from `src/valueObject/idleTimeoutMs.ts`.
2. `src/idleWaiting.ts` — the pure logic. It reads the host Message shapes,
   takes the newest real assistant completion as the idle anchor — skipping
   the auto-compactor's summary turn — and formats elapsed time, local start
   date and time, and timer color. It hides the line unless the session status
   is `idle`.
3. `src/state.ts` — reads the master switch, the `idle-clock` flag, the idle
   compactor flag, and the timeout override from the shared state file each
   tick, so `/essentials` changes take effect without a restart.
4. `src/features/idle-clock.ts` — the `SuiteFeature` entry (no `buildHooks`),
   which lists the feature in the dialog and gates the master switch.
5. `src/valueObject/timestampMs.ts` — the trust boundary for the message and
   wall-clock times that reach the logic.

---

## Exec Wrapper Guard

Checks inner commands hidden by natural bash wrappers against agent bash
permission rules.

**Flow:**

1. `.opencode/plugins/exec-wrapper-guard.ts` — OpenCode auto-loader. It
   re-exports the plugin from the source module.
2. `src/exec-wrapper-guard.ts` — inspects wrapped bash commands and checks
   inner commands against agent bash permission rules in `opencode.json`.
3. `src/exec-wrapper-guard.test.ts` — verifies wrapper checks, permission
   results, failure handling, ignored tools, and config reloads.

Ask rules cannot open a prompt from this hook. The plugin tells the user to
run an ask command unwrapped. Interpreter code, script files, `make`, `npm run`,
`xargs`, and `parallel` remain outside this text-layer guard.

---

## Sub-agent Timestamps

Task rows in the OpenCode TUI show the local date and time when a sub-agent
starts and finishes.

**Flow:**

1. `tmp/opencode-src/packages/tui/src/routes/session/index.tsx` — reads the
   task tool's start and finish timestamps and formats them with the TUI's
   locale helper.
2. `tmp/opencode-src/packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx`
   — verifies the displayed timestamp format.

---

## Native Skills (planned)

Promotes the `.agents/skills` playbooks to native OpenCode skills. Not yet implemented; the code path is not traceable. Roadmap item 3 in `TODO.md`.

---

## KDE Permission Notifications (planned)

Shows KDE notifications when opencode requests a permission, with an allow action on the banner. Not yet implemented; the code path is not traceable. Roadmap item 4 in `TODO.md`.

---

## /grill (planned)

A lighter review command with a question cap. Not yet implemented; the code path is not traceable. Roadmap item 5 in `TODO.md`.

---

## /review (planned)

A review command with the dispatch envelope, rule and skill curation, LOC sizing, and a focus lens. Not yet implemented; the code path is not traceable. Roadmap item 6 in `TODO.md`.

---
