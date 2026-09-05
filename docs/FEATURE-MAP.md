# Feature Map

> Auto-maintained index of every user-facing feature and the code path that implements it. Updated alongside the code — not after the fact.

## Idle Auto Compactor

Compacts an OpenCode session automatically after the session stays continuously idle for 30 minutes (configurable). The feature is event-driven and uses one-shot timers, never polling. It is feature 1 of the essentials plugin suite and can be toggled and tuned at runtime from the TUI.

**Flow:**

1. `src/server.ts` — server entry. Builds each feature's hooks from per-feature options and fans them out via `combineHooks`.
2. `src/features/registry.ts` — lists the `idle-auto-compactor` `SuiteFeature` for both entry points.
3. `src/features/idle-auto-compactor.ts` — the feature. Subscribes to `session.status` and `session.deleted`. An idle status arms a one-shot timer; a busy status cancels it; a genuine `chat.message` reopens the idle period. When the timer fires, it reads the session messages, picks the last user message's model, and calls `session.summarize`. The state machine absorbs the compaction's own busy/idle echoes.
4. `src/state.ts` — the shared config protocol. The server reads `$XDG_DATA_HOME/opencode/essentials.json` at each decision point: the master switch gates the feature, and the file's timeout setting overrides the plugin option.
5. `src/valueObject/` — the trust boundary. Every external string and number (event session ids, model tokens, config timeouts, state-file keys, `XDG_DATA_HOME`) becomes a branded type through a `new*` constructor before use.
6. `src/tui.ts` — TUI companion, registered in `tui.json` (the TUI host does
   not read `opencode.json`). The `/essentials` command opens a
   `DialogSelect` with the master switch, the feature flags, and the
   idle-timeout submenu; every choice is written to the state file.
7. `src/README.md` — installation, configuration, and the exact semantics.

---

## Exec Wrapper Blind Spot (planned)

Closes the bash permission blind spot where prefix executors (`timeout`, `nohup`, `bash -c`, `mise exec`, `direnv exec`) hide the inner command from opencode's permission tiers. Planned as another feature in the same essentials bundle. Not yet implemented; the code path is not traceable. Roadmap item 2 in `TODO.md`.

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