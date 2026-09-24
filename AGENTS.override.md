# AGENTS.override.md

Project-specific instructions that take precedence over AGENTS.md.

## No Patched-OpenCode Features

This plugin suite will not provide anything that requires a patched version of
OpenCode. Every feature must work against a stock OpenCode release, through
plugin APIs only (server hooks, TUI entries, the permission chain, config). If
a desired behavior is unreachable that way, it is out of scope: do not
implement it in a local OpenCode source tree, and do not document or advertise
it as a feature. Report the missing plugin capability instead.
