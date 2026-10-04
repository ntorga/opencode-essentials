---
name: agent-browser
description: Browser inspection and interaction for verifying rendered web UI during development. Use agent-browser with a private session and Chrome.
---

# Agent browser

## Purpose

Source files do not prove a rendered page is correct. CSS can be purged,
client-side JS runs only in the browser, and server-rendered markup can differ
from the template. This skill verifies the rendered result with agent-browser,
a CLI that drives a real Chrome session.

## Procedure

### 1. Claim your own session

The default session is one browser shared by every agent on the machine.
Another agent can navigate away from your page mid-task. Ask agent-browser for
a worktree-scoped session id and pass it to every command:

```bash
agent-browser session id --scope worktree --prefix "ui-verify-<agent-name>"
agent-browser --session ui-verify-coder-<worktree-hash> open http://localhost:3000/page
```

The command prints the full id: it keeps the prefix and appends the worktree
hash. A shell export does not survive between tool calls. The session travels
as a flag.

### 2. Run the verification loop

After every UI change:

1. Edit the source file.
2. Rebuild, or let the watcher handle it.
3. Wait for the server to serve `localhost:<port>`.
4. Inspect the rendered result.
5. Interact with the component.
6. Read the screenshot and fix issues.

### 3. Snapshot before you interact

Refs come from the accessibility snapshot. Take a new snapshot after every
navigation, state change, or DOM update:

```bash
agent-browser --session <id> open http://localhost:3000/page
agent-browser --session <id> snapshot -i
agent-browser --session <id> click @e3
agent-browser --session <id> snapshot -i
```

### 4. Inspect rendered state

```bash
agent-browser --session <id> get styles "h1"        # CSS classes actually applied
agent-browser --session <id> console                # console logs
agent-browser --session <id> errors                 # page errors only
agent-browser --session <id> network requests       # captured requests
agent-browser --session <id> eval 'document.title'  # client-side state
```

Wrap the `eval` payload in single quotes and use double quotes for strings
inside it:

```bash
agent-browser --session <id> eval '(() => { const rows = document.querySelectorAll("[data-test]");
return rows.length; })()'
```

A single-quoted payload parses as one permission pattern, on one line or
across lines.

Check console errors after every UI change.

### 5. Fill a form

```bash
agent-browser --session <id> snapshot -i
agent-browser --session <id> fill @e2 "test value"
agent-browser --session <id> press Tab               # trigger blur and validation
agent-browser --session <id> snapshot -i
```

### 6. Wait for async work

After a server request or an animation, wait before you re-snapshot:

```bash
agent-browser --session <id> click @e5
agent-browser --session <id> wait networkidle
agent-browser --session <id> snapshot -i
```

### 7. Open hidden content

Dropdowns and modals stay hidden until triggered. Click the trigger, then
re-snapshot for refs to the visible elements.

### 8. Capture the result

```bash
agent-browser --session <id> screenshot --annotate /tmp/component-state.png
```

Read the file after you capture it. The annotation overlay shows element refs
on the rendered page.

### 9. Verify the finished feature visually

When the feature work is done, capture the final state without the annotation
overlay and Read the image file:

```bash
agent-browser --session <id> screenshot /tmp/<feature>-done.png
```

The screenshot enters your context as an image only when you Read it. Inspect
it for what text output cannot show: alignment, spacing, overlap, clipping,
contrast, and broken styles. Fix what looks wrong, then capture again.

## Setup and edge cases

### Test responsive layouts

Only when the feature changes layout behavior:

```bash
agent-browser --session <id> set viewport 375 812
agent-browser --session <id> screenshot --annotate /tmp/mobile.png

agent-browser --session <id> set viewport 1280 800
agent-browser --session <id> screenshot --annotate /tmp/desktop.png
```

### Trust the local certificate

A locally hosted app often serves HTTPS with a self-signed certificate the
browser refuses. For localhost or a private IP address, pass
`--ignore-https-errors` on every command:

```bash
agent-browser --session <id> --ignore-https-errors open https://localhost:3000/page
```

Never pass the flag to a public host. It disables certificate validation.

### Install

```bash
command -v agent-browser >/dev/null || { npm install -g agent-browser && agent-browser install; }
```

The Chrome download runs only on a fresh install.

## Guardrails

- Never assume a rendered component is correct from source code alone.
- Never report a UI feature done from text output alone. Capture the final
  state and Read the screenshot before you report.
- Never wrap an `eval` payload in double quotes. Single quotes outside,
  double quotes inside: `agent-browser eval '(() => { ... })()'`.
- Never run agent-browser in the shared default session. Pass `--session <id>`
  on every command.
- Never reuse agent-browser refs across page states. Re-snapshot after any
  change.
- Never use Lightpanda. It has no rendering engine, so its output does not
  match what a user sees.
- Never use agent-browser to debug a live user session. It cannot access the
  user's cookies or auth state. Ask the user to reproduce the state instead.
- Never run more than 3 browser sessions at the same time. More sessions
  starve the host and the work already in progress.
