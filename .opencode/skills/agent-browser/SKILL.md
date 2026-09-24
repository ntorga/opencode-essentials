---
name: agent-browser
description: Use when a user asks for browser inspection or when rendered web behavior must be verified. Use agent-browser with a private session and Chrome.
metadata:
  source: ai-framework-browser-usage
  version: "0.3.1"
---

# Agent browser

Use a browser to verify rendered behavior. Source files do not prove that a
page, client-side script, or stylesheet works in the browser.

## Start a private session

Check whether `agent-browser` is installed. If it is missing, tell the user
to run these commands:

```bash
npm install -g agent-browser
agent-browser install
```

Use Chrome for every session.

Create a worktree-scoped session ID:

```bash
agent-browser session id --scope worktree --prefix "ui-verify-coder"
```

Pass the returned ID to every later command. Do not use the shared default
session.

```bash
agent-browser --engine chrome --session <session-id> open http://localhost:3000
```

For a local site with a self-signed certificate, add
`--ignore-https-errors`. Never use that flag on a public host.

## Verify the page

After each UI change:

1. Build the application or wait for its watcher.
2. Open the local page in the private session.
3. Read an interactive snapshot.
4. Interact with the page and take a new snapshot after each state change.
5. Check browser errors and console output.
6. Capture and read a screenshot when layout or styling changed.

```bash
agent-browser --engine chrome --session <session-id> snapshot -i
agent-browser --engine chrome --session <session-id> click @e3
agent-browser --engine chrome --session <session-id> snapshot -i
agent-browser --engine chrome --session <session-id> errors
agent-browser --engine chrome --session <session-id> console
agent-browser --engine chrome --session <session-id> screenshot --annotate /tmp/ui.png
```

Take a new snapshot after navigation, async updates, or interaction. Never
reuse element references from an older page state.

## Check layouts

Use a narrow viewport when the page must work on mobile. Return to a desktop
viewport after that check.

```bash
agent-browser --engine chrome --session <session-id> set viewport 375 812
agent-browser --engine chrome --session <session-id> screenshot --annotate /tmp/mobile.png
agent-browser --engine chrome --session <session-id> set viewport 1280 800
agent-browser --engine chrome --session <session-id> screenshot --annotate /tmp/desktop.png
```

Do not run more than three browser sessions at once. Do not use the browser to
inspect a live user's authenticated session.
