# opencode-essentials

One plugin package, two entry points, several features. The server entry
runs the features. The TUI companion gives the user a palette command to
enable or disable each feature at runtime.

```
src/
  server.ts    default export { id, server }   — feature host (server-side)
  tui.ts       default export { id, tui }      — toggle dialog (TUI-side)
  state.ts     shared state file protocol      — written by tui, read by server
  valueObject/ one validated type per file     — the input trust boundary
  hooks.ts     fans one hook out to all features
  log.ts       structured logging through client.app.log
  features/
    feature.ts   the SuiteFeature contract
    registry.ts  the feature list both entries read
    idle-auto-compactor.ts  feature 1
```

A module exports either `server()` or `tui()`, never both — OpenCode's
loader enforces that. A package exposes both kinds through its two entry
files, and each host picks the entry that matches its kind.

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

Register the TUI entry in `tui.json`:

```json
{
  "plugin": ["./src/tui.ts"]
}
```

Paths resolve relative to the declaring config file. The two hosts read
separate config files: the server host loads `opencode.json` and the TUI
host loads `tui.json`. Restart OpenCode after changing either file.

Toggling does not need a restart. Type `/essentials` in the prompt, or
open the command palette (`ctrl+p` by default) and run **Toggle Essentials
Features**. Move to a feature and press Enter. The choice is written to
`$XDG_DATA_HOME/opencode/essentials.json` (default
`~/.local/share/opencode/essentials.json`) and takes effect at each
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

Toggle state lives in `$XDG_DATA_HOME/opencode/essentials.json`. If the
server cannot read it, the feature keeps its last known decision and logs
`FeatureStatesReadFailed`. The plugin refuses to overwrite a state file it
cannot parse, so a corrupt file never silently resets stored toggles. The
TUI shows an error toast when a write is refused.

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

- OpenCode 1.18.x, verified against 1.18.18. The server half uses the
  `session.status` event and the `session.summarize` API. The TUI half
  uses the TUI plugin surface (`keymap.registerLayer`, `ui.dialog`,
  `ui.DialogSelect`, `ui.toast`).
- No runtime dependencies. Both entries import types and Node built-ins
  only. No `package.json` needed in `.opencode/`.

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
