# opencode-essentials

> **Work in progress.** Do not use this project. It is unpublished,
> unfinished, and its behavior may change or break at any commit.
>
> **Vibe coded.** Agents wrote this code because the project is low-stakes.
> The author nitpicked the result, and every review finding is fixed, but do
> not expect the care of hand-written code.

A suite of plugins for [OpenCode](https://opencode.ai), version 1. One
installable package has three entry points: a server plugin that runs the
features, a TUI companion that toggles them at runtime, and a TUI idle clock
that shows how long the open session has waited for your input. The project
also provides an auto-loaded `.opencode` plugin for wrapped bash commands.

## Features

- **Idle Auto Compactor** (implemented): compacts a session after it stays
  continuously idle, 30 minutes by default. It skips recent compactions and
  sessions below 32,000 context tokens. Event-driven, never polls.
- **Token Ceiling Compactor** (implemented): compacts a session once its
  context passes a chosen token ceiling — 384k by default, 128k to 1M
  selectable — regardless of the model, clamped to smaller model windows.
  OpenCode continues the model after it creates the summary.
- **Idle Session Clock** (implemented): a TUI line that shows how long the
  open session has been idle since the model stopped answering. It shows the
  idle start date and changes color as the compactor timeout approaches.
  Hides while the model works; toggled from `/essentials`.
- **Exec wrapper guard** (implemented): checks commands hidden by natural
  bash wrappers against the generated permission rules.
- **Sub-agent timestamps** (implemented in `tmp/opencode-src`): task rows show
  when each sub-agent started and finished.
- **KDE permission notifications** (planned): notifies on permission
  requests, with an allow action.

## Development

Requires Node 24+, Bun 1.3+, and OpenCode 1.18.x for manual testing.

```
npm install
cd .opencode
bun install
cd ..
npm run test:plugin
npm test          # node --test
npm run typecheck # tsc --noEmit
```

OpenCode also runs `bun install` in `.opencode` at startup.

Installation, configuration, and feature semantics live in
[`src/README.md`](src/README.md).
