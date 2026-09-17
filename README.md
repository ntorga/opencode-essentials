# opencode-essentials

> **Work in progress.** Do not use this project. It is unpublished,
> unfinished, and its behavior may change or break at any commit.
>
> **Vibe coded.** Agents wrote this code because the project is low-stakes.
> The author nitpicked the result, and every review finding is fixed, but do
> not expect the care of hand-written code.

A suite of plugins for [OpenCode](https://opencode.ai), version 1. One
installable package, three entry points: a server plugin that runs the
features, a TUI companion that toggles them at runtime, and a TUI idle clock
that shows how long the open session has waited for your input.

## Features

- **Idle Auto Compactor** (implemented): compacts a session after it stays
  continuously idle, 30 minutes by default. Event-driven, never polls.
- **Idle Session Clock** (implemented): a TUI line that shows how long the
  open session has been idle since the model stopped answering. Hides while
  the model works; toggled from `/essentials`.
- **Exec wrapper blind spot** (planned): makes wrapped commands visible to
  the permission tiers.
- **KDE permission notifications** (planned): notifies on permission
  requests, with an allow action.

## Development

Requires Node 24+ and OpenCode 1.18.x for manual testing.

```
npm install
npm test          # node --test
npm run typecheck # tsc --noEmit
```

Installation, configuration, and feature semantics live in
[`src/README.md`](src/README.md).
