# opencode-essentials

> **Work in progress.** Do not use this project. It is unpublished,
> unfinished, and its behavior may change or break at any commit.
>
> **Vibe coded.** Agents wrote this code because the project is low-stakes.
> The author nitpicked the result, and every review finding is fixed, but do
> not expect the care of hand-written code.

A suite of plugins for [OpenCode](https://opencode.ai), version 1. Server
plugins run the features; TUI plugins manage the switches, render a shared
status bar, and assist with permissions.

## Features

- **Idle Auto Compactor**: compacts a session after it stays idle for a while
  (30 minutes by default). It leaves recently compacted and small sessions
  alone.
  - *Problem it solves:* a session left sitting overnight carries a bloated
    context into your next task.
- **Token Ceiling Compactor**: compacts a session once its context passes a
  token ceiling you pick, whatever the model. OpenCode carries on from the
  summary.
  - *Problem it solves:* the model drifts and forgets the plan once the
    context window grows too large.
- **Idle Session Clock**: shows how long the open session has waited for your
  input, leading the status bar and changing color as compaction nears.
  Toggle it from `/essentials`.
  - *Problem it solves:* with several sessions open, you cannot tell which
    ones wait on you.
- **Permission Assistant**: screens pending permission requests against
  OpenRouter's Decisions API before they reach you. Jev is the default
  classifier model; switch it from `/essentials`. Routine safe requests are
  approved; anything the model cannot vouch for keeps the normal prompt open,
  and a doom loop is answered with a correction instead of waking you.
  Credentials come from `opencode auth login`.
  - *Problem it solves:* an unattended run stalls on every routine command
    that needs approval.
- **Permission Notifications**: on Linux, raises a pending request as a
  desktop notification with an "Allow once" action when the notification
  server supports it. OpenCode's own prompt stays as a fallback.
  - *Problem it solves:* a prompt waits unseen behind a backgrounded terminal.
- **Reasoning Loop Guard**: watches the reasoning stream for text the model
  repeats without progress. When a suspect tail appears, Jev judges it; at
  0.80 confidence or higher the guard cancels the response and sends the
  model a correction, the way the doom-loop guard handles repeated tool
  calls. If three checks in a row fail to clear the same loop — abstentions
  or unreachable checks — the guard stops chasing verdicts, cancels the run,
  and wakes you with a notification. Toggle it from `/essentials`.
  - *Problem it solves:* a model that spirals mid-reasoning burns tokens and
    time until you notice and abort it yourself.
- **Response Usage Status**: shows a provider health verdict, output speed,
  thinking-inclusive throughput, and response latencies in the shared status
  bar. Toggle it from `/essentials`.
  - *Problem it solves:* "is my provider healthy?" has no visible answer
    while a response runs.
- **Embedded Skills and Commands**: adds `/grill`, `/humanizer`,
  `/web-search`, and `/agent-browser` with matching native OpenCode skills.
  - *Problem it solves:* plan reviews, research, and rendered-UI checks each
    need a careful prompt every time you want one.
- **Exec Wrapper Guard**: unwraps commands the agent hides behind wrappers
  like `timeout`, `env`, `mise exec`, or `bash -c` and checks the real inner
  command against your permission rules.
  - *Problem it solves:* rules match the wrapper, not the command — so a
    common `timeout 5 git diff` fails its allow rule until you register every
    prefixed variant, and forbidden commands escape wrapped.

Every Permission Assistant decision — who approved it and how the model
scored it — is recorded in a local audit log you can mine to trim your allow
and deny lists. See [src/README.md](src/README.md) for the full behavior.

## The status bar

One themed footer row, shared by the clock and the metrics:

```
idle: 2m 38s · healthy (62/118 tok/s ~ 0.4s/11.3s)
```

- `idle: 2m 38s` — how long the session has waited for your input. It turns
  yellow at half of the auto-compactor timeout and red at 80 percent. Once
  the wait passes thirty minutes it gains a `| since 4:03 PM` stamp, and the
  date joins the stamp when the wait began before today.
- `healthy (…)` — the provider verdict, and the window of readings that
  justify it. The verdict and the numbers share one window: the completed
  responses of the last five minutes or the newest eighteen, whichever
  boundary is reached first. Every response in it is graded — a rate under
  40 tok/s or a start above 3s is troubled, under 20 or above 10s is poor.
  One third troubled makes the word `degraded` (yellow), one third poor
  makes it `underperforming` (red), and a clean window reads `healthy`
  (green). The word needs at least three responses, so a fresh session shows
  the numbers alone, with no brackets. Once the window empties, the metrics
  disappear with it rather than repeat stale numbers.
- `62/118 tok/s` — visible output speed over total generation speed. The
  first number counts every token the host bills as output: message text and
  tool-call payloads alike, because a tool call streams into your transcript
  token by token just like prose. The second adds the model's hidden thinking
  tokens over the same active time. The pair answers "is the provider slow,
  or is the model just thinking?" — `20/200` means the provider streams fine
  and the wait was reasoning, while `20/24` means the provider genuinely
  crawls. The gap is the thinking share. On a non-reasoning model you see one
  number. Yellow below 40, red below 20.
- `~ 0.4s/11.3s` — the average waits: until the model started answering, and
  until the first visible text. The color follows the start value: yellow
  above 3s, red above 10s. Only the numbers carry color.

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
