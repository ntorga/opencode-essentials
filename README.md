# opencode-essentials

> **Work in progress.** Do not use this project. It is unpublished,
> unfinished, and its behavior may change or break at any commit.

A suite of plugins for [OpenCode](https://opencode.ai), version 1. One
installable package with two entry points: a server plugin that runs the
features, and a TUI companion that toggles each feature at runtime without
a restart.

## Features

- **Idle Auto Compactor** (implemented): compacts a session after it stays
  continuously idle, 30 minutes by default. Event-driven, never polls.
- **Exec wrapper blind spot** (planned): makes wrapped commands visible to
  the permission tiers.
- **Native skills** (planned): promotes local skill playbooks to native
  OpenCode skills.
- **KDE permission notifications** (planned): notifies on permission
  requests, with an allow action.

The roadmap lives in `TODO.md` (not published).

## Layout

```
src/
  server.ts              server entry: runs every feature
  tui.ts                 TUI entry: feature toggles from the command palette
  state.ts               toggle protocol (shared JSON file)
  hooks.ts, log.ts       event fan-out, structured logging
  features/              one file per feature, plus the registry
  README.md              plugin installation, configuration, semantics
docs/
  FEATURE-MAP.md         feature-to-code index
```

## Development

Requires Node 24+ and OpenCode 1.18.x for manual testing.

```
npm install
npm test          # node --test
npm run typecheck # tsc --noEmit
```

Plugin installation and the exact idle-compaction semantics are documented
in [`src/README.md`](src/README.md).
