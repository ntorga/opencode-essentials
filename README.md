# opencode-essentials

> **Work in progress.** Do not use this project. It is unpublished,
> unfinished, and its behavior may change or break at any commit.
>
> **Vibe coded.** Agents wrote this code because the project is low-stakes.
> The author nitpicked the result, and every review finding is fixed, but do
> not expect the care of hand-written code.

A suite of plugins for [OpenCode](https://opencode.ai), version 1. The package
has one server entry and four TUI entries. The server runs the features. The
TUI entries manage feature switches, show the idle clock, assist with
permissions, and display response usage. The project also provides an
auto-loaded `.opencode` plugin for wrapped bash commands.

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
- **Permission Assistant** (implemented): sends pending Bash permission
  requests to OpenRouter's Decisions API. Jev is the default model. A safe
  probability of `0.80` or higher replies once. Other results keep the
  OpenCode prompt open. It reuses credentials from `opencode auth login`.
- **Permission Notifications** (implemented): uses the freedesktop.org
  notification service on Linux. The notification offers an **Allow once**
  action when the notification server supports actions. OpenCode keeps its
  normal prompt as a fallback.
- **Response Usage Status** (implemented): shows output tokens, output speed,
  time to first visible text, response duration, and cost on a themed footer
  panel. Toggle it from `/essentials`.
- **Embedded Skills and Commands** (implemented): adds `/grill`,
  `/humanizer`, `/web-search`, and `/agent-browser` with matching native
  OpenCode skills.
- **Exec wrapper guard** (implemented): checks commands hidden by natural
  bash wrappers against the generated permission rules.
- **Sub-agent timestamps** (implemented in `tmp/opencode-src`): task rows show
  when each sub-agent started and finished.

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
