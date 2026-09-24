# Feature Map

> Auto-maintained index of every user-facing feature and the code path that implements it. Updated alongside the code — not after the fact.

## Idle Auto Compactor

Compacts an OpenCode session automatically after the session stays continuously idle for 30 minutes (configurable). The feature is event-driven and uses one-shot timers, never polling. It is feature 1 of the essentials plugin suite and can be toggled and tuned at runtime from the TUI.

**Flow:**

1. `src/server.ts` — server entry. Builds each feature's hooks from per-feature options and fans them out via `combineHooks`.
2. `src/features/registry.ts` — lists the `idle-auto-compactor` `SuiteFeature` for both entry points.
3. `src/features/idle-auto-compactor.ts` — the feature. Subscribes to `session.status` and `session.deleted`. An idle status arms a one-shot timer; a busy status cancels it; a genuine `chat.message` reopens the idle period. When the timer fires, it skips a last compaction and a newest real turn under 32,000 tokens. It summarizes with the measured turn's model. The state machine absorbs the compaction's own busy/idle echoes.
4. `src/state.ts` — the shared config protocol. The server reads `$XDG_DATA_HOME/opencode/essentials.json` at each decision point: the master switch gates the feature, and the file's timeout setting overrides the plugin option.
5. `src/valueObject/` + `src/documents/` — the trust boundary. Every external string and number (event session ids, model tokens, config timeouts, state-file keys, `XDG_DATA_HOME`) becomes a branded type through a `new*` constructor, and every whole payload (the state file, message events, the auth store entry) passes a parser, before use.
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
2. `src/features/contextCeiling.ts` — pure logic: measure the newest real completed
   turn (usage tokens + model ref, skipping summary turns), read the model's
   context window from the provider list, clamp the ceiling to it.
3. `src/features/sessionSummarizer.ts` — the shared `session.summarize`
   request (deadline, error mapping); idle compaction stays manual, while
   token-ceiling compaction asks OpenCode to continue after its summary.
4. `src/valueObject/contextTokens.ts` — the validated token ceiling:
   presets 128k–1M, default 384k, hard max 2,000,000.
5. `src/state.ts` + `src/documents/essentialsDocument.ts` — the
   `ceilingTokens` settings entry in the shared state file; the
   `/essentials` submenu in `src/tui.ts` writes it.

---

## Idle Session Clock

Shows how long the open session has been idle — the time since the model
stopped answering and left the floor to the user — at the start of the shared
status bar. It includes the local idle start date and time. It turns yellow at
half of the idle auto-compactor timeout and red at 80 percent. It is feature 3
of the essentials suite and is toggled at runtime from the same `/essentials`
dialog. It is a TUI-only feature: it has no server hooks.

**Flow:**

1. `tui.json` — loads `src/usage-status.tsx` with the idle compactor timeout
   option.
2. `src/usage-status.tsx` — registers one padded `app_bottom` row. It puts the
   idle counter before the response metrics.
3. `src/statusBar/idleClockStatus.ts` — reads idle session state and resolves the
   configured timeout and display color.
4. `src/statusBar/idleWaiting.ts` — the pure logic. It reads the host Message shapes,
   takes the newest real assistant completion as the idle anchor — skipping
   the auto-compactor's summary turn — and formats elapsed time, local start
   date and time, and timer color. The host only tracks busy and retry states,
   so a missing status is idle; the line hides only while busy or retrying.
5. `src/state.ts` — reads the master switch, the `idle-clock` flag, the idle
   compactor flag, and the timeout override from the shared state file each
   tick, so `/essentials` changes take effect without a restart.
6. `src/features/idle-clock.ts` — the `SuiteFeature` entry (no `buildHooks`),
   which lists the feature in the dialog and gates the master switch.
7. `src/valueObject/timestampMs.ts` — the trust boundary for the message and
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

## Permission Assistant and Desktop Notifications

Checks pending Bash permission requests with OpenRouter's Decisions API. Jev is
the default. The permission assistant reads OpenRouter credentials from
OpenCode's auth store, with an environment-variable fallback. `/essentials`
can change the classifier model while OpenCode is running. A safe probability
of 0.80 or higher replies once. Other results keep the prompt open and trigger
a desktop notification when TUI notifications are enabled.

**Flow:**

1. `tui.json` — loads the TUI permission assistant.
2. `src/permission-assistant.tsx` — listens for `permission.asked`, checks the
   feature toggle, validates the request, and reads the selected model.
3. `src/openRouterAuth.ts` — reads the OpenRouter API key from OpenCode's auth
   store and falls back to `OPENROUTER_API_KEY`.
4. `src/valueObject/permissionRequest.ts`, `src/valueObject/permissionName.ts`,
   `src/valueObject/permissionRequestId.ts`, `src/valueObject/openRouterApiKey.ts`,
   and `src/valueObject/openRouterModelId.ts` — validate request fields,
   credentials, model IDs, and reply identifiers.
5. `src/features/permissionDecision.ts` — sends Bash patterns to the Decisions API and
   validates the returned safe probability.
6. `src/features/notificationText.ts` — places request text after the end-of-options
   marker and escapes markup characters before passing it as the notification
   body.
7. `src/permission-assistant.tsx` — replies `once` at 0.80 or higher.
   Otherwise it keeps the prompt open and uses Linux `notify-send` or the TUI
   attention API when notifications are enabled. The Linux action can reply
   `once`.
8. `src/features/permission-assistant.ts`, `src/features/registry.ts`,
   `src/tui.ts`, `src/state.ts`, and
   `src/documents/essentialsDocument.ts` — expose the feature toggle and
   persist a model selected in `/essentials`.
9. `src/openRouterAuth.test.ts`, `src/features/permissionDecision.test.ts`,
   `src/valueObject/permissionRequest.test.ts`,
   `src/valueObject/openRouterApiKey.test.ts`, and
   `src/valueObject/openRouterModelId.test.ts` — test credential and model
   validation. `src/features/notificationText.test.ts` checks notification text safety.

OpenCode v1 creates the pending request before the TUI receives it. The
permission prompt may appear while Jev classifies it. The notification button
uses the freedesktop.org action protocol; a notification server may ignore
actions.

---

## Response Usage Status

Shows output tokens per second and a start/first-text/total latency group,
averaged over the newest completed assistant responses; reasoning turns pair
the rate as `output/all-generation tok/s`. The themed status bar places the
idle counter first when the session is idle. Slow rates and slow response
starts change color. It does not show the output token count or response
cost.

**Flow:**

1. `tui.json` — loads `src/usage-status.tsx` as the shared status bar and
   passes the idle compactor timeout option.
2. `src/usage-status.tsx` — checks feature toggles and registers one padded
   footer row for the active session.
3. `src/valueObject/sessionId.ts` — validates the active session ID before the
   TUI reads its messages and parts.
4. `src/usage-status.tsx` and `src/statusBar/usageStatus.ts` — read the validated
   session's messages and parts, then average the newest three completed
   responses. The token rate divides generated tokens by the part window
   minus tool execution time; the pair shows output speed over
   thinking-inclusive speed, so the first value never exceeds the second.
   Latency starts count only inside the message's created-to-completed
   window. Slow values render in warning or error colors.
5. `src/statusBar/tone.ts` — the shared muted/warning/error tone vocabulary
   and its theme mapping for status-bar text.
6. `src/valueObject/messageId.ts`, `src/valueObject/tokenCount.ts`, and
   `src/valueObject/timestampMs.ts` — validate response metrics before
   calculations.
7. `src/features/usage-status.ts`, `src/features/registry.ts`, `src/tui.ts`,
   and `src/state.ts` — expose and persist the `/essentials` feature toggle.
8. `src/statusBar/usageStatus.test.ts` — tests response selection, timing,
   generation-time rates, tones, and displayed metrics.

---

## Embedded Skills and Slash Commands

Adds native skills and matching commands for `/grill`, `/humanizer`,
`/web-search`, and `/agent-browser`. Each command invokes the skill with the
user's arguments. The grill asks only about decisions that are hard to revert
or force rework, capped at 30 questions, with no more than three in one round.

**Flow:**

1. `.opencode/skills/grill/SKILL.md` — defines the capped plan interview.
2. `.opencode/commands/grill.md` — exposes the skill as `/grill`.
3. `.opencode/skills/humanizer/SKILL.md` — defines prose rewriting rules.
4. `.opencode/commands/humanizer.md` — exposes the skill as `/humanizer`.
5. `.opencode/skills/web-search/SKILL.md` — defines search, fetch, and citation
   rules.
6. `.opencode/commands/web-search.md` — exposes the skill as `/web-search`.
7. `.opencode/skills/agent-browser/SKILL.md` — defines private browser
   verification.
8. `.opencode/commands/agent-browser.md` — exposes the skill as `/agent-browser`.

---

## /review (planned)

A review command with the dispatch envelope, rule and skill curation, LOC sizing, and a focus lens. Not yet implemented; the code path is not traceable.

---
