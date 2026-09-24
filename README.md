# opencode-essentials

> **Work in progress.** Do not use this project. It is unpublished,
> unfinished, and its behavior may change or break at any commit.
>
> **Vibe coded.** Agents wrote this code because the project is low-stakes.
> The author nitpicked the result, and every review finding is fixed, but do
> not expect the care of hand-written code.

A suite of plugins for [OpenCode](https://opencode.ai), version 1. The package
has one server entry and three TUI entries. The server runs the features. The
TUI entries manage feature switches, render a shared status bar, and assist
with permissions. A separate auto-loaded `.opencode` plugin checks wrapped
bash commands.

## Features

- **Idle Auto Compactor**: compacts a session after it stays continuously idle,
  30 minutes by default. It skips a session that was recently compacted or
  holds under 32,000 context tokens. It reacts to events and never polls.
  Use it when sessions go untouched overnight and you want the next task to
  start on a trimmed context.
- **Token Ceiling Compactor**: compacts a session once its context passes a
  chosen token ceiling, regardless of the model: 384k by default, selectable
  from 128k to 1M, clamped down to fit smaller model windows. OpenCode
  continues the model after it creates the summary. Use it on long refactors
  so the session never hits the model's context wall mid-task.
- **Idle Session Clock**: shows how long the open session has been idle since
  the model stopped answering. It leads the shared status bar and changes
  color as the compactor timeout approaches. Toggle it from `/essentials`.
  Use it to spot which of your open sessions has been waiting on input the
  longest, and to see when auto-compaction is about to fire.
- **Permission Assistant**: sends pending Bash permission requests to
  OpenRouter's Decisions API, with Jev as the default model. A safe
  probability of `0.80` or higher gets one reply; every other result keeps the
  OpenCode prompt open. It reuses credentials from `opencode auth login`. Use
  it when a routine `git push` would otherwise stall an unattended run.
- **Permission Notifications**: uses the freedesktop.org notification service
  on Linux. The notification offers an "Allow once" action when the
  notification server supports actions. OpenCode keeps its normal prompt as a
  fallback. Use it when the terminal is in the background and you want to
  answer a pending request from the notification itself.
- **Response Usage Status**: shows output speed, thinking-inclusive
  throughput, and response latencies in the shared themed status bar.
  Toggle it from `/essentials`. Use it to tell a stuck provider from a long
  generation without guessing.
- **Embedded Skills and Commands**: adds `/grill`, `/humanizer`,
  `/web-search`, and `/agent-browser` with matching native OpenCode skills.
  Use `/grill` to stress-test a plan before code, `/web-search` for research,
  and `/agent-browser` to check rendered UI.
- **Exec wrapper guard**: checks commands hidden by natural bash wrappers
  against the generated permission rules. Use it so a rule that rejects
  `git push` still holds when the agent wraps the call in a bash script.

## The status bar

One themed footer row, shared by the clock and the metrics:

```
idle: 2m 38s | since 4:03 PM · 62/118 tok/s · latency: 0.4s/11.3s/48.6s
```

- `idle: 2m 38s | since ...` — how long the session has waited for your
  input, and when the model stopped answering. The date joins the stamp only
  when the wait began before today. It turns yellow at half of the
  auto-compactor timeout and red at 80 percent.
- `62/118 tok/s` — output speed over total generation speed, including
  thinking tokens. The gap between the numbers is the thinking share. On a
  non-reasoning model you see one number. Yellow below 40, red below 20.
- `latency: 0.4s/11.3s/48.6s` — time until the model started answering,
  until the first visible text, and until the turn finished. Thinking counts
  in the first-text wait. The color follows the start value: yellow above 3s,
  red above 10s. Only the numbers carry color.

The full measurement rules live in
[`src/README.md`](src/README.md#response-usage-status).

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
