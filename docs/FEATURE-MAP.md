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
status bar. It stamps the local idle start time once the wait passes thirty
minutes, adding the date for waits that began before today. It turns yellow at
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
   the auto-compactor's summary turn — and formats elapsed time, the local
   start stamp (only past the thirty-minute mark, with the date for
   earlier-day waits), and timer color.
   The host only tracks busy and retry states,
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
permission rules. Supported wrappers: `env`, `timeout`, `nohup`, `nice`,
`stdbuf`, `setsid`, `sh`/`bash`/`zsh -c` scripts, `mise exec`, `mise x`, and
`direnv exec`.

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

Checks pending permission requests with OpenRouter's Decisions API. Jev is
the default. Every request OpenCode cannot decide from its own rules is asked
of Jev first; only an unclear verdict reaches the human. Bash, edit, and
external-directory have dedicated safety questions; any other permission name
gets a generic one. A doom-loop request is answered without Jev: the
assistant rejects it with a correction message that tells the agent it is
repeating itself. The permission assistant reads
OpenRouter credentials from OpenCode's auth store, with an environment-variable
fallback. `/essentials` can change the classifier model while OpenCode is
running. A safe probability of 0.80 or higher replies once. Other results keep
the prompt open and trigger a desktop notification. On Linux the notification
carries **Allow once** and **Allow always** buttons; it does not depend on the
TUI attention settings.

Every decision on a permission request is audited to `permission-audit.log` in
the OpenCode data directory. A JSON line records each Jev classification that
reaches a still open request (permission, model, safe probability, auto-allow
verdict, and the model's explanation when it provides one) and each request a
human, the classifier, or the assistant allowed or rejected (permission,
patterns, session id, actor `classifier`, `user`, or `assistant`, reply). A
decision line that follows a below-threshold verdict also carries that verdict
under `classifier`, so the human's reply shows why Jev deferred. Requests that
OpenCode's own allow or deny rules handle never reach a prompt, so they never
reach this log. Inspect the file to decide which commands or paths to add to
the allow list.

**Flow:**

1. `tui.json` — loads the TUI permission assistant.
2. `src/permission-assistant.tsx` — listens for `permission.asked`, checks the
   feature toggle, validates the request, and reads the selected model.
3. `src/openRouterAuth.ts` — reads the OpenRouter API key from OpenCode's auth
   store and falls back to `OPENROUTER_API_KEY`.
4. `src/valueObject/permissionRequest.ts`, `src/valueObject/permissionName.ts`,
   `src/valueObject/permissionRequestId.ts`, `src/valueObject/sessionId.ts`,
   `src/valueObject/openRouterApiKey.ts`, and
   `src/valueObject/openRouterModelId.ts` — validate request fields,
   credentials, model IDs, and reply identifiers.
5. `src/features/permissionDecision.ts` — resolves the safety question for the
   request's permission, sends its patterns to the Decisions API, and
   validates the returned verdict: safe probability plus an optional
   explanation from the answering model.
6. `src/features/permissionAudit.ts` — appends the classification and decision
   lines to the audit log, sanitizing and length-capping each pattern and
   explanation.
7. `src/features/notificationText.ts` — places request text after the
   end-of-options marker and escapes markup characters before passing it as
   the notification body.
8. `src/permission-assistant.tsx` — replies `once` at 0.80 or higher, or
   `reject` with a correction message for a doom loop. Otherwise it keeps the
   prompt open and uses Linux `notify-send`, falling back to the gated TUI
   attention API when that spawn fails. The desktop buttons reply `once` or
   `always`.
9. `src/features/permission-assistant.ts`, `src/features/registry.ts`,
   `src/tui.ts`, `src/state.ts`, and
   `src/documents/essentialsDocument.ts` — expose the feature toggle and
   persist a model selected in `/essentials`.
10. `src/openRouterAuth.test.ts`, `src/features/permissionDecision.test.ts`,
    `src/features/permissionAudit.test.ts`,
    `src/valueObject/permissionRequest.test.ts`,
    `src/valueObject/openRouterApiKey.test.ts`, and
    `src/valueObject/openRouterModelId.test.ts` — test credential, model, and
    audit-line validation. `src/features/notificationText.test.ts` checks
    notification text safety.

OpenCode v1 creates the pending request before the TUI receives it. The
permission prompt may appear while Jev classifies it. The notification button
uses the freedesktop.org action protocol; a notification server may ignore
actions.

---

## Reasoning Loop Guard

Cancels a response whose reasoning repeats itself. The doom-loop guard in the
Permission Assistant only sees repeated tool calls; this guard watches the
reasoning stream. It keeps the last 256 reasoning words per response, checks
every 128 new words, and treats the final 24-word phrase appearing three
times in the window as a suspect. A suspect goes to Jev's Decisions API
through the shared classifier request; at 0.80 or higher the guard aborts the
run and delivers a correction prompt that names the spiral. A verdict that
arrives after the response ended is dropped. Two caps bound the guard: three
confirmed interrupts per user turn, and three uncleared readings on the same
loop — abstentions, failed calls, or a missing credential — after which the
fourth suspect is treated as a runaway regardless of the classifier, so the
guard cancels without a verdict. A TUI companion counts the same suspects and
wakes the human at the fourth. Server feature 5; a `/essentials`
row toggles it and the classifier model of the Permission Assistant applies to
it too.

**Flow:**

1. `src/server.ts` — server entry. Builds the guard's hooks with the feature's options.
2. `src/features/reasoning-loop-guard.ts` — the shared suspect watcher tracks the
   reasoning tail; the server subscribes to `message.part.updated`, feeds the
   watcher, asks `session.abort` and delivers the correction through
   `session.promptAsync`, and spends the interrupt and abstention budgets.
3. `src/features/permissionDecision.ts` — the shared Decisions API request,
   the "stuck" question for reasoning spirals, and the 0.80 confirmation
   threshold.
4. `src/openRouterAuth.ts` + `src/state.ts` — the credential and the
   classifier model, shared with the Permission Assistant; the toggle file
   gates the feature at the decision point.
5. `src/reasoning-loop-escalation.tsx` — TUI companion. It runs the same suspect
   watcher over `message.part.updated` and, at the fourth suspect in a
   response, raises the human wake-up through the attention API (toast
   fallback), logging `ReasoningLoopHumanEscalation`.
6. `src/tui.ts` — the `/essentials` row toggles the guard at runtime.
7. `src/features/reasoning-loop-guard.test.ts` — tests spiral detection,
   confirmed interrupts, cleared and stale verdicts, the budgets, and the
   disabled paths.

---

## Response Usage Status

Shows a provider health verdict and the response metrics that justify it, in
the form `healthy (62/118 tok/s ~ 0.4s/11.3s)`. One window feeds both: the
completed assistant responses of the last five minutes or the newest
eighteen, whichever boundary is reached first. The rate pools output tokens
over active generation time, and reasoning turns pair it as
`output/all-generation tok/s`. The verdict copies the colors of the numbers
it leads: all blue renders `flying`, all green `healthy`, all yellow
`sluggish`, any red `slow`, and colors that disagree `regular` in grey. The
themed
status bar places the idle counter first when the session is idle, then the
verdict leading its bracketed numbers. Values and their units change color;
brackets and separators stay muted. It does not
show the output token count or response cost.

**Flow:**

1. `tui.json` — loads `src/usage-status.tsx` as the shared status bar and
   passes the idle compactor timeout option.
2. `src/usage-status.tsx` — checks feature toggles and registers one padded
   footer row for the active session.
3. `src/valueObject/sessionId.ts` — validates the active session ID before the
   TUI reads its messages and parts.
4. `src/usage-status.tsx` and `src/statusBar/usageStatus.ts` — read the validated
   session's messages and parts, then pool the rate, take the median of the
   waits, and pick the verdict from the numbers' tones. The
   token rate divides generated tokens by the part window minus tool execution
   time; the pair shows visible output speed over thinking-inclusive speed, so
   the first value never exceeds the second. Latency starts count only inside
   the message's created-to-completed window. Fewer than three responses in the
   window hide the verdict but keep the numbers. Fast values render in info
   or good colors, slow ones in warning or error.
5. `src/statusBar/tone.ts` — the shared info/good/muted/warning/error tone
   vocabulary and its theme mapping for status-bar text.
6. `src/valueObject/messageId.ts`, `src/valueObject/tokenCount.ts`, and
   `src/valueObject/timestampMs.ts` — validate response metrics before
   calculations.
7. `src/features/usage-status.ts`, `src/features/registry.ts`, `src/tui.ts`,
   and `src/state.ts` — expose and persist the `/essentials` feature toggle.
8. `src/statusBar/usageStatus.test.ts` — tests response selection, timing,
   generation-time rates, health grades and window bounds, tones, and
   displayed metrics.

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
