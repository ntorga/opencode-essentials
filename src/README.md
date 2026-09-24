# opencode-essentials

One plugin package, four entry points, several features. The server entry runs
server features. The TUI entries manage features, handle permission requests,
and render a shared status bar. The feature dialog lets the user switch all
features off, change feature states, and tune idle timeouts, token ceilings,
and the classifier model. The idle clock shows how long the open session has
waited for input.

```
src/
  server.ts    default export { id, server }   — feature host (server-side)
  tui.ts       default export { id, tui }      — toggle dialog (TUI-side)
  permission-assistant.tsx TUI pending-permission listener and notifier
  usage-status.tsx default export { id, tui }   — shared status bar (TUI-side)
  exec-wrapper-guard.ts    plugin wrapping shell-command permission checks
  state.ts     shared state file protocol      — written by tui, read by server
  openRouterAuth.ts        reads OpenCode's auth store for the API key
  hooks.ts     fans one hook out to all features
  log.ts       structured logging through client.app.log
  documents/   one parser per external payload — state file, messages, auth entry
  valueObject/ one validated type per file     — the input trust boundary
  statusBar/   idle clock, idle anchor, and response metrics for the footer
  features/
    feature.ts   the SuiteFeature contract
    registry.ts  the feature list both entries read
    idle-auto-compactor.ts  feature 1
    token-ceiling-compactor.ts  feature 2
    sessionSummarizer.ts  shared session.summarize call
    idle-clock.ts  feature 3 (TUI-only, no server hooks)
    permission-assistant.ts  feature 4 row
    usage-status.ts  feature 5 row
    contextCeiling.ts  shared ceiling logic — turn usage, model window, clamp
    permissionDecision.ts  classifier request and response validation
    notificationText.ts  notify-send argument building
    requestDeadline.ts  shared client request deadline
```

A module exports either `server()` or `tui()`, never both — OpenCode's
loader enforces that. A package exposes both kinds through its entry files,
and each host picks the entry that matches its kind.

## Features

### Idle Auto Compactor

Compacts a session after it stays continuously idle. Default 30 minutes,
configurable per project.

- A session becomes idle (`session.status` → `idle`): a one-shot timer
  starts for that session.
- The session becomes busy before the timer fires: the timer is cancelled.
- The session stays continuously idle until the timer fires: the plugin
  compacts it through the official `session.summarize` API — the same path
  `/compact` uses. No keystrokes are simulated.
- Each idle period compacts at most once. The compaction turn emits its own
  busy/idle events; the plugin marks the period settled when the timer
  fires, so those echoes cannot re-trigger compaction.
- A genuine user message (`chat.message`) reopens the state. The next idle
  period can trigger the next compaction.
- Timers and state are tracked per session. `session.deleted` and plugin
  shutdown clear them.
- The compaction uses the newest completed real answer's model. It skips a
  session after a compaction message and when that answer used fewer than
  32000 context tokens.

### Token Ceiling Compactor

Compacts a session once its context passes a token ceiling, regardless of
the model. Default 384k, selectable from `/essentials`: 128k, 256k, 384k,
512k, 768k, or 1M.

- After each finished turn (`session.status` → `idle`), the plugin reads the
  session's messages and measures the newest real answer: the sum of its
  input, output, and cache tokens — the same numbers OpenCode's own
  overflow check uses.
- The ceiling check runs at most once per idle period; a genuine user
  prompt reopens it. Each idle period settles
  when the check runs, so the compaction turn's own busy/idle echo cannot
  re-trigger it; a new `chat.message` reopens the period.
- Small-context guard: the effective ceiling is the smaller of the chosen
  value and the model's own context window, looked up from the host's
  provider list. A 200k model with a 384k ceiling compacts at 200k. A model
  the provider list does not describe keeps the chosen ceiling — unknown is
  not small.
- The measurement never uses the compactor's own summary turn, and the
  compaction runs through the official `session.summarize` API with the
  model of the measured turn. The token-ceiling request asks OpenCode to
  continue after the summary, so the model does not stop on the compact
  message.
- The master switch, the **Token Ceiling Compactor** row, and the
  **token ceiling** picker in `/essentials` control it without a restart.
  The `ceilingTokens` plugin option sets a per-project default below the
  stored value.

### Idle Session Clock

Shows an idle counter at the start of the shared status bar while the open
session waits for your input, for example `idle 3m 12s · since 9/22/26,
10:20 AM`. It is a TUI-only feature: it renders inside the OpenCode TUI from
the host's synced state, so it has no server hooks.

- The clock anchors on the completion of the newest real assistant answer —
  the moment the model stopped answering. It counts up from there.
- The auto-compactor's own summary turn does not re-anchor the clock, so an
  automatic compaction does not reset your displayed wait to zero.
- The line is hidden while the session is `busy` or `retry`, while the
  transcript has no finished answer yet, and on the home route.
- When the Idle Auto Compactor is enabled, the line turns yellow at half of
  its timeout and red at 80 percent. The clock reads the timeout from the
  shared state file, then the TUI plugin option. Keep the TUI plugin option
  in `tui.json` aligned with the server plugin option in `opencode.json`.
- It re-derives the wait from synced message state each second, so it needs
  no event subscription. The host tracks only busy and retry sessions, so a
  session with no status entry is idle: a session reopened from history, or
  switched to mid-day, shows its true elapsed wait immediately.
- The master switch and the **Idle Session Clock** row in `/essentials`
  gate it. A change takes effect on the next tick, without a restart. An
  unreadable state file hides the line rather than resurrecting a clock the
  user may have switched off.

### Permission Assistant

The Permission Assistant listens for pending permission requests in the TUI.
OpenCode evaluates `opencode.json` rules first. Only requests that still need
an answer reach this flow.

- Bash requests go to OpenRouter's Decisions API. The default model is
  `typesafe/jev-1.13`. Essentials reads the OpenRouter key from OpenCode's
  `auth.json` file. `OPENROUTER_API_KEY` is an optional fallback.
- Essentials reads the model's safe probability. A value of `0.80` or higher
  replies `once` through the OpenCode client. This reply does not save a
  permission rule.
- A lower score, a missing credential, an invalid response, or a network error
  leaves the normal permission prompt open.
- OpenCode v1 publishes a pending request before the TUI sees it. The prompt
  can appear briefly while Jev classifies the request.
- On Linux, `notify-send` creates a freedesktop.org notification with an
  **Allow once** action. KDE, GNOME, Budgie, and other notification servers
  can show the action when they support notification actions. The prompt stays
  available if the notification server ignores the action.
- A desktop action replies `once`. A user reply in the TUI cancels the
  classifier request and closes the notification.
- Only Bash requests go to OpenRouter. Essentials sends permission patterns.
  It does not send the session transcript or project path.
- OpenRouter's [Jev guide](https://openrouter.ai/docs/guides/community/jev)
  describes the model and Decisions API. Its [permission prompt
  example](https://openrouter.ai/docs/cookbook/coding-agents/auto-approve-permission-prompts-with-jev)
  shows how to use the API.
- Linux notifications use the action list in the
  [freedesktop.org notification protocol](https://specifications.freedesktop.org/notification/latest/protocol.html).
- The freedesktop notification body accepts XML markup. Essentials escapes
  command text before it displays the text. See the
  [markup rules](https://specifications.freedesktop.org/notification/latest/markup.html).
- The **Permission Assistant** row in `/essentials` controls classification
  and permission notifications. Disabling it leaves OpenCode's normal prompt
  unchanged.
- The **Permission Assistant model** row changes the model without a restart.
  Enter a `provider/model` ID. The row can restore Jev as the default.

The model must support OpenRouter's Decisions API. Jev is a structured
decision model. It is not a regular chat model.

### Response Usage Status

The shared status bar appears after a completed assistant response. It shows
output tokens per second, thinking-inclusive throughput when the model
reasons, and the start, first-text, and total latencies. When the session is
idle, the idle counter appears first on the same padded line.

- The rate divides generated tokens by active generation time: the window
  from a response's first to its last part timestamp, minus tool execution.
  Streaming, thinking, argument writing, and queue gaps count; tool runs and
  permission waits do not. A response without measurable part timing falls
  back to its full duration.
- The pair `X/Y tok/s` reads output speed over total generation speed. X
  counts text and tool-call tokens; Y adds reasoning tokens, over the same
  active time. X never exceeds Y; the gap is how much of the turn's budget
  went to thinking.
- Known limit: `tokens.output` includes tool-call payloads, and a response
  that opens with a tool call hides that call's argument time before the
  first part timestamp. Such turns read slightly fast.
- Latency shows as `latency: start/first text/total`, all measured from
  assistant-message creation. Start is when the model began producing its
  first part — reasoning or text. First text is when visible text began;
  the gap between the two is thinking time. Total runs until completion and
  includes tools and waits. When the model does not reason, start and first
  text coincide and the bar collapses to `latency: first/total`. When part
  timing is missing, it degrades to the total alone, muted.
- The token rate turns yellow below 40 tok/s and red below 20 tok/s. The
  latency group takes its color from the start value: yellow above 3s, red
  above 10s. A slow start is a provider problem; long thinking is not. Only
  the numbers carry color; labels and units stay muted.
- The status bar does not show the output token count or response cost.
- The **Response Usage Status** row in `/essentials` controls the line.

## Skills and slash commands

The project provides four native OpenCode skills in `.opencode/skills/`:
`grill`, `humanizer`, `web-search`, and `agent-browser`. Matching files in
`.opencode/commands/` expose `/grill`, `/humanizer`, `/web-search`, and
`/agent-browser`. The grill asks only about decisions that are hard to revert
or force rework, capped at 30 questions, with no more than three in one round.
Restart OpenCode after changing a skill or command.

## Installation

Register the server entry in `opencode.json`:

```json
{
  "plugin": [
    [
      "./src/server.ts",
      {
        "features": {
          "idle-auto-compactor": { "idleTimeoutMs": 1800000 },
          "token-ceiling-compactor": { "ceilingTokens": 512000 }
        }
      }
    ]
  ]
}
```

Set the status bar's idle compactor timeout in `tui.json` to the same value as
the server plugin timeout. The default is `1800000` milliseconds in both files.

Register the TUI entries in `tui.json`:

```json
{
  "plugin": [
    "./src/tui.ts",
    "./src/permission-assistant.tsx",
    [
      "./src/usage-status.tsx",
      {
        "features": {
          "idle-auto-compactor": { "idleTimeoutMs": 1800000 }
        }
      }
    ]
  ]
}
```

Paths resolve relative to the declaring config file. The two hosts read
separate config files: the server host loads `opencode.json` and the TUI
host loads `tui.json`. Restart OpenCode after changing either file.

The permission assistant reads the `openrouter` API key from the OpenCode
auth store in `$XDG_DATA_HOME/opencode/auth.json` (default
`~/.local/share/opencode/auth.json`). `OPENROUTER_API_KEY` is an optional
fallback. OpenRouter receives Bash permission patterns for classification.
Essentials does not send the session transcript or project path.

Toggling does not need a restart. Type `/essentials` in the prompt, or
open the command palette (`ctrl+p` by default) and run **Toggle Essentials
Features**. The dialog offers five kinds of row:

- **All features** — the master switch. Turning it off stops every feature
  at once and keeps each per-feature choice untouched.
- **One row per feature** — enable or disable that feature. A feature
  stays off while the master switch is off.
- **Permission Assistant model** — enter a custom OpenRouter Decisions model
  ID or restore Jev as the default.
- **One row per adjustable timeout** — opens a submenu of preset idle
  timeouts plus a custom value in minutes.
- **One row per adjustable token ceiling** — opens a submenu of preset
  ceilings (128k to 1M) plus a custom token count.

Choices are written to `$XDG_DATA_HOME/opencode/essentials.json` (default
`~/.local/share/opencode/essentials.json`) and take effect at each
feature's next decision point. The server half reads that file from its own
machine. A `opencode serve` running on another machine would not see
toggles made by a local TUI. This suite assumes a local server, which is
the default.

## Configuration

Server entry options — read once at startup:

| Option | Type | Default |
|--------|------|---------|
| `features.idle-auto-compactor.idleTimeoutMs` | number | `1800000` (30 min) |
| `features.token-ceiling-compactor.ceilingTokens` | number | `384000` |

The classifier model is stored at
`settings.permission-assistant.model` in `essentials.json`. The default is
`typesafe/jev-1.13`. Change it in `/essentials` by entering a `provider/model`
ID. Only Bash permission patterns that remain at `ask` are sent to the
configured model. The request has an eight-second timeout. A missing
credential, network error, or invalid response leaves the prompt open.

`ceilingTokens` is the context size, in tokens, at which the ceiling
compactor runs. A missing value falls back to the default silently. A
present-but-invalid value — non-integer, zero, negative, or above
2,000,000 — falls back and is logged as `InvalidCeilingTokens`.

`idleTimeoutMs` is the continuous idle time before a session is compacted.
A missing value falls back to the default silently; a present-but-invalid
value (non-numeric, zero, or negative) falls back and is logged as
`InvalidIdleTimeoutMs`. A value above
Node's timer ceiling (`2^31-1` ms, about 24.8 days) is clamped to it and
logged as `IdleTimeoutMsClamped`.

A timeout set through `/essentials` overrides the option; the option is the
default until the user chooses. Precedence, highest first: state-file
setting, plugin option, built-in default. The dialog shows the state-file
layer only: a footer reads "(stored)" when the user chose, or "(default)"
otherwise. The plugin option is invisible to the TUI, so "(default)" covers
both the built-in 30 minutes and any `idleTimeoutMs` from `opencode.json`.

State file (`$XDG_DATA_HOME/opencode/essentials.json`), current shape:

```json
{
  "version": 1,
  "enabled": true,
  "features": {
    "idle-auto-compactor": false,
    "idle-clock": true,
    "permission-assistant": true,
    "usage-status": true
  },
  "settings": {
    "idle-auto-compactor": { "idleTimeoutMs": 1800000 },
    "token-ceiling-compactor": { "ceilingTokens": 384000 },
    "permission-assistant": { "model": "typesafe/jev-1.13" }
  }
}
```

A pre-version file — a flat feature-id-to-boolean map — is read as legacy
and rewritten in this shape on the first write. If the server cannot read
the file, the feature keeps its last known decision and logs
`EssentialsConfigReadFailed`. The plugin refuses to overwrite a state file
it cannot parse, so a corrupt file never silently resets stored choices.
The TUI shows an error toast when a write is refused.

## Semantics in detail

- **Idle means the session finished a turn.** A `busy` status or a new user
  message stops the timer; the clock restarts on the next idle transition.
- **Compaction does not loop.** The compaction turn's own busy/idle events
  are ignored. Only a genuine user message reopens the idle period.
- **Toggling off is immediate at the next decision.** A timer armed before
  disabling cannot compact: the feature state is checked again when the
  timer fires. Re-enabling arms the next idle transition.
- **Activity during a compaction is handled on the next cycle.** If a user
  message arrives while a compaction is in flight, the session compacts
  again after the next full busy/idle cycle and the idle timeout elapse.
- **Errors are loud and non-fatal.** Failures are logged
  (`IdleCompactionRejected`, `IdleCompactionFailed`) and the idle period is
  still settled. No retries within the same period. Each call to the
  OpenCode server carries a 60-second deadline.
- **Sessions idle at startup wait.** The plugin arms on the idle
  transition. A session already idle when OpenCode started compacts after
  its next idle transition, not sooner.
- **State is small and per session.** One tiny record per session seen,
  dropped on `session.deleted` or shutdown.

## Requirements

- OpenCode 1.18.x, verified against 1.18.30. The server uses session events,
  message reads, session summaries, and provider metadata. The TUI uses
  `api.event`, `api.client.permission.reply`, `api.attention`, and
  `slots.register`.
- The entries use Node built-ins and TUI host modules. OpenCode provides
  `solid-js` and `@opentui/*` at runtime. On Linux, `notify-send` provides the
  desktop action when installed. The TUI attention API provides a fallback.
- The new TUI entries add no npm packages. `.opencode/package.json` provides
  the existing wrapped-shell guard dependencies.

## Tests

From the repository root:

```
npm install
npm test          # node --test
npm run typecheck # tsc --noEmit
```

## Manual verification

1. Register both entries (see Installation) with a short `idleTimeoutMs`,
   e.g. `60000`.
2. Open a session, send a prompt, wait for the reply.
3. Stay away for the timeout. The session compacts once: a summary turn
   appears and the context indicator drops.
4. Send a message, wait again. The session compacts once more.
5. Type `/essentials`, or open the command palette and run **Toggle
   Essentials Features**. Disable the compactor. Repeat step 2-3: nothing
   compacts. The file `~/.local/share/opencode/essentials.json` records the
   choice.
6. Re-enable and let an idle period elapse: compaction resumes without a
   restart.
7. Enable only the Token Ceiling Compactor with a low ceiling (e.g.
   `{"ceilingTokens": 2000}` in the state file). Send one prompt: the
   finished turn's usage passes the ceiling and the session compacts once,
   then the model continues after the summary. Answer again: it compacts once
   more, never twice per turn.
8. Watch the status bar while the session waits. Confirm the idle counter
   starts the line and ticks once a second. Send a prompt: the counter hides
   while the model answers and returns with the new wait.
9. Type `/essentials` and disable **Idle Session Clock**: the counter
   disappears within a second. Re-enable it: the counter returns with the
   true elapsed time.
10. Run `opencode auth login` and set `permission.bash` to `ask` in
    `opencode.json`. Ask the agent to run a safe Bash command. A Jev
    probability of at least `0.80` replies once. A lower or invalid result
    leaves the prompt open.
11. Type `/essentials`, open **Permission Assistant model**, choose a custom
    model, and enter its OpenRouter `provider/model` ID. Open the row again
    and restore the Jev default.
12. Trigger a pending permission with a low Jev probability. Check that the
    desktop notification offers **Allow once**. Dismissing it must leave the
    OpenCode prompt open.
13. Complete an assistant response. Check that the status bar shows token
    rate, first-text latency, and total latency — a reasoning turn pairs the
    rate as `X/Y tok/s` — without an output count or cost. Disable
    **Response Usage Status** to hide those metrics.
