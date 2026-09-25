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
- **Permission Assistant**: a classifier model judges each pending permission
  before it reaches you. Jev is the default; switch it from `/essentials`.
  Routine safe requests are approved, anything the model cannot vouch for
  keeps the normal prompt, and a doom loop is answered with a correction
  instead of waking you.
  - *Problem it solves:* an unattended run stalls on every routine command
    that needs approval.
- **Permission Notifications**: on Linux, raises a pending request as a
  desktop notification with "Allow once" and "Allow always" actions when the
  notification server supports them. OpenCode's own prompt stays as a
  fallback.
  - *Problem it solves:* a prompt waits unseen behind a backgrounded terminal.
- **Reasoning Loop Guard**: watches the reasoning stream for a model that
  keeps rewriting the same thought without progress. Jev confirms the loop
  and the guard cancels the run, feeding the model a correction instead of
  another wasted turn. When its own checks keep failing to clear a loop, it
  stops chasing verdicts and wakes you instead. Toggle it from
  `/essentials`.
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
  - *Problem it solves:* rules match the wrapper, not the command. A common
    `timeout 5 git diff` fails its allow rule until you register every
    prefixed variant, and wrapped commands escape the forbidden ones.

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
  justify it. The window holds the completed responses of the last five
  minutes or the newest eighteen, whichever boundary is reached first. The
  verdict copies the colors of its numbers:

  | Verdict | Color | Rule |
  |---|---|---|
  | `flying` | blue | all numbers blue |
  | `healthy` | green | all numbers green |
  | `regular` | grey | the colors disagree |
  | `sluggish` | yellow | all numbers yellow |
  | `slow` | red | any number red |

  The word needs three responses, so a fresh session shows the numbers
  alone, with no brackets. Once the window empties, the metrics disappear
  with it rather than repeat stale numbers.
- `62/118 tok/s` — visible output speed against total generation speed,
  which adds the model's hidden thinking tokens. The pair answers "is the
  provider slow, or is the model just thinking?": `20/200` streams fine and
  the wait was reasoning, while `20/24` genuinely crawls. A non-reasoning
  model shows one number. Blue above 80, green above 40, yellow above 20,
  red below.
- `~ 0.4s/11.3s` — the median waits: until the model started answering, and
  until the first visible text. The color follows the start value: blue
  under 1.5s, green under 3s, yellow under 10s, red above. Numbers and
  units carry the color; the separators stay grey.

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
