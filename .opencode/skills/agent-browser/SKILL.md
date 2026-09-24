---
name: agent-browser
description: Use when a user asks for browser inspection or when rendered web behavior must be verified. Use agent-browser with a private session and Chrome.
---

# Agent browser

## Purpose

Source files do not prove a rendered page is correct. CSS can be purged,
client-side JS runs only in the browser, and server-rendered markup can differ
from the template. This skill verifies the rendered result with agent-browser,
a CLI that drives a real Chrome session.

## Procedure

### Set up the session

1. **Check the install.** Run `agent-browser --version`. When the command is
   missing, ask the user to install it:

   ```bash
   npm install -g agent-browser
   agent-browser install   # downloads Chrome for Testing (first time only)
   ```

2. **Always pass `--engine chrome`.** Lightpanda has no rendering engine, so
   its output does not match what a user sees.

3. **Claim your own session.** The default session is one browser shared by
   every agent on the machine. Another agent can navigate away from your page
   mid-task. Create a worktree-scoped session id and pass it to every later
   command:

   ```bash
   agent-browser session id --scope worktree --prefix "ui-verify-coder"
   agent-browser --engine chrome --session <session-id> open http://localhost:3000
   ```

   A shell export does not survive between tool calls. The session travels as a
   flag, not an environment variable.

4. **Trust the local certificate.** A locally hosted app often serves HTTPS
   with a self-signed certificate. The browser refuses the page until the
   certificate is trusted. For a localhost or private IP address, add
   `--ignore-https-errors` on every command. Never pass the flag to a public
   host: it disables certificate validation, so it belongs only on a host you
   run yourself.

### Run the verification loop

After every UI change:

1. Edit the source file.
2. Rebuild, or let the watcher handle it.
3. Wait for the server to serve `localhost:<port>`.
4. Open the page in your session and inspect the rendered result.
5. Interact with the component.
6. Read the screenshot and fix issues.

Never assume a component is correct without looking at it.

### Inspect the page

7. **Snapshot before you interact.** Refs come from the accessibility
   snapshot. Take a new snapshot after every navigation, state change, or DOM
   update. Never reuse refs across page states.

   ```bash
   agent-browser --engine chrome --session <session-id> snapshot -i
   agent-browser --engine chrome --session <session-id> click @e3
   agent-browser --engine chrome --session <session-id> snapshot -i
   ```

8. **Open hidden content.** Dropdowns and modals stay hidden until triggered.
   Click the trigger, then re-snapshot for refs to the visible elements.

9. **Fill a form step by step.** Press `Tab` after a field to trigger blur and
   validation, then re-snapshot to read the result.

   ```bash
   agent-browser --engine chrome --session <session-id> fill @e2 "test value"
   agent-browser --engine chrome --session <session-id> press Tab
   agent-browser --engine chrome --session <session-id> snapshot -i
   ```

10. **Wait for async work.** After a server request or an animation, wait
    before you re-snapshot.

    ```bash
    agent-browser --engine chrome --session <session-id> wait networkidle
    ```

11. **Check rendered state.** Run these after every UI change; console and
    page errors carry failures the screenshot does not show.

    ```bash
    agent-browser --engine chrome --session <session-id> errors
    agent-browser --engine chrome --session <session-id> console
    agent-browser --engine chrome --session <session-id> get styles "h1"
    agent-browser --engine chrome --session <session-id> eval "document.title"
    ```

12. **Capture the result and read it.** The annotation overlay shows element
    refs on the rendered page.

    ```bash
    agent-browser --engine chrome --session <session-id> screenshot --annotate /tmp/ui.png
    ```

13. **Test responsive layouts.** Use a narrow viewport when the page must work
    on mobile. Return to a desktop viewport after that check.

    ```bash
    agent-browser --engine chrome --session <session-id> set viewport 375 812
    agent-browser --engine chrome --session <session-id> screenshot --annotate /tmp/mobile.png
    agent-browser --engine chrome --session <session-id> set viewport 1280 800
    agent-browser --engine chrome --session <session-id> screenshot --annotate /tmp/desktop.png
    ```

## Guardrails

- Never assume a rendered component is correct from source code alone.
- Never run agent-browser in the shared default session. Pass `--session <id>`
  on every command.
- Never reuse agent-browser refs across page states. Re-snapshot after any
  change.
- Never use Lightpanda. It has no rendering engine.
- Never pass `--ignore-https-errors` to a public host.
- Never use agent-browser to debug a live user session. It cannot access the
  user's cookies or auth state.
- Never run more than 3 browser sessions at the same time. More sessions
  starve the host and the work already in progress.
