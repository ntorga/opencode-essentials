# opencode-essentials

One plugin package, three entry points, several features. The server entry
runs the features. The TUI companion gives the user a command to switch
everything off at once, enable or disable each feature at runtime, and
tune a feature's idle timeout. The TUI idle clock shows, on screen, how long
the open session has waited for your input.

```
src/
  server.ts    default export { id, server }   — feature host (server-side)
  tui.ts       default export { id, tui }      — toggle dialog (TUI-side)
  idle-clock.tsx default export { id, tui }    — idle session clock line (TUI-side)
  idleWaiting.ts clock logic                   — anchor, elapsed, and format
  state.ts     shared state file protocol      — written by tui, read by server
  valueObject/ one validated type per file     — the input trust boundary
  hooks.ts     fans one hook out to all features
  log.ts       structured logging through client.app.log
  features/
    feature.ts   the SuiteFeature contract
    registry.ts  the feature list both entries read
    idle-auto-compactor.ts  feature 1
    idle-clock.ts  feature 2 (TUI-only, no server hooks)
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
- The compaction uses the model of the session's last user message. A
  session is skipped when it has no user message or that message carries
  no model.

### Idle Session Clock

Shows one line at the bottom of the screen while the open session waits for
your input, for example `idle 3m 12s`. It is a TUI-only feature: it renders
inside the OpenCode TUI from the host's synced state, so it has no server
hooks.

- The clock anchors on the completion of the newest real assistant answer —
  the moment the model stopped answering. It counts up from there.
- The auto-compactor's own summary turn does not re-anchor the clock, so an
  automatic compaction does not reset your displayed wait to zero.
- The line is hidden while the session is `busy` or `retry`, while the
  transcript has no finished answer yet, and on the home route.
- It re-derives the wait from synced message state each second, so it needs
  no event subscription, and a session already idle when the TUI started
  shows its true elapsed wait.
- The master switch and the **Idle Session Clock** row in `/essentials`
  gate it. A change takes effect on the next tick, without a restart. An
  unreadable state file hides the line rather than resurrecting a clock the
  user may have switched off.

## Installation

Register the server entry in `opencode.json`:

```json
{
  "plugin": [
    [
      "./src/server.ts",
      {
        "features": {
          "idle-auto-compactor": { "idleTimeoutMs": 1800000 }
        }
      }
    ]
  ]
}
```

Register the TUI entries in `tui.json`:

```json
{
  "plugin": ["./src/tui.ts", "./src/idle-clock.tsx"]
}
```

Paths resolve relative to the declaring config file. The two hosts read
separate config files: the server host loads `opencode.json` and the TUI
host loads `tui.json`. Restart OpenCode after changing either file.

Toggling does not need a restart. Type `/essentials` in the prompt, or
open the command palette (`ctrl+p` by default) and run **Toggle Essentials
Features**. The dialog offers three kinds of row:

- **All features** — the master switch. Turning it off stops every feature
  at once and keeps each per-feature choice untouched.
- **One row per feature** — enable or disable that feature. A feature
  stays off while the master switch is off.
- **One row per adjustable timeout** — opens a submenu of preset idle
  timeouts plus a custom value in minutes.

Choices are written to `$XDG_DATA_HOME/opencode/essentials.json` (default
`~/.local/share/opencode/essentials.json`) and take effect at each
feature's next decision point. The server half reads that file from its own
machine. A `opencode serve` running on another machine would not see
toggles made by a local TUI. This suite assumes a local server, which is
the default.

## Configuration

Server entry options — read once at startup:

| Option                             | Type   | Default            |
|------------------------------------|--------|--------------------|
| `features.idle-auto-compactor.idleTimeoutMs` | number | `1800000` (30 min) |

`idleTimeoutMs` is the continuous idle time before a session is compacted.
A missing, non-numeric, zero, or negative value falls back to the default.
The plugin logs `InvalidIdleTimeoutMs` when it falls back. A value above
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
  "features": { "idle-auto-compactor": false, "idle-clock": true },
  "settings": { "idle-auto-compactor": { "idleTimeoutMs": 1800000 } }
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

- OpenCode 1.18.x, verified against 1.18.29. The server half uses the
  `session.status` event and the `session.summarize` API. The TUI half
  uses the TUI plugin surface (`keymap.registerLayer`, `ui.dialog`,
  `ui.DialogSelect`, `ui.DialogPrompt`, `ui.toast`, `slots.register`).
- No dependencies to install. The entries import types, Node built-ins,
  and host-provided runtime modules only: `solid-js` and `@opentui/*` for
  the clock's view, which the OpenCode TUI registers for plugins at load.
  No `package.json` needed in `.opencode/`.

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
7. Watch the bottom line while the session waits: it ticks once a second
   and shows `idle 0s` right after a reply. Send a prompt: the line
   disappears while the model answers and returns counting the new wait.
8. Type `/essentials` and disable **Idle Session Clock**: the line
   disappears within a second. Re-enable: it returns with the true elapsed
   time.
