---
name: web-search
description: Use /web-search for current facts, external systems, or public tools. Search, fetch the needed content, and cite sources.
---

# Web search

## Purpose

Answers about current facts, public tools, and external systems need web
grounding. Search finds pages. Fetch reads them. Search runs through the
TinyFish CLI. Page fetch tries the native `webfetch` tool first and falls back
to the TinyFish CLI when the native tool is blocked. Full flag reference:
https://docs.tinyfish.ai/cli/commands

## Procedure

### Verify the tool

1. **Check for the CLI.** Run `command -v tinyfish`. If it is missing, stop and
   tell the user to install it:

   ```bash
   npm install -g @tiny-fish/cli
   ```

   The tool is free. It needs an API key, so the user creates one and completes
   login with `tinyfish auth login` themselves.

   Do not install the tool or run `tinyfish auth login` on your own. Once the
   user confirms setup, continue.

2. **Check authentication.** Run `tinyfish auth status`. If it reports no valid
   key, tell the user to run `tinyfish auth login` themselves and stop.

### Choose the surface

3. **Answer from local context first.** Use project files and the conversation
   when they hold the answer. Skip the web when the question is about this
   codebase.
4. **Search when the right page is unknown.** Use search for "what is", "how
   does", and "compare" questions, and for anything time-sensitive: versions,
   releases, prices, news.
5. **Fetch when the page is known.** Try the native `webfetch` tool first. Fall
   back to `tinyfish fetch content get` when the native tool is blocked, fails,
   or returns empty content.

### Search

6. **Run the search.**

   ```bash
   tinyfish search query "best React state management libraries"
   ```

   Add hints when the question is geo- or language-specific:

   ```bash
   tinyfish search query "best pho in Saigon" --location "Vietnam" --language "en"
   ```

7. **Read the results before the next search.** The default output is JSON.
   Each result carries `position`, `site_name`, `title`, `url`, and `snippet`.
   A snippet often answers a simple question. Fetch only the pages that need
   full content.

### Fetch

8. **Fetch with the TinyFish CLI.** Use this when the native `webfetch` tool is
   blocked or fails:

   ```bash
   tinyfish fetch content get "https://example.com/article"
   ```

   One call accepts up to 10 URLs. The server fetches them in parallel.

9. **Read the content.** Each entry in `results` carries `title`, `final_url`,
   `author`, `published_date`, and `text`. The `text` field holds clean
   markdown. Ads and navigation are stripped. Check `errors` for failed URLs;
   the other results still succeed.

10. **Adjust the extraction when needed.** Pass `--links` or `--image-links` to
   also collect outbound links or images. Set `--per-url-timeout-ms 45000` for
   slow sites. Use `--format html` or `--format json` when markdown loses
   structure you need.

### Ground the answer

11. **Cite the sources.** Name the URL behind every external fact. Never state
   a fact the fetched content does not support.

## Guardrails

- Never use `tinyfish agent run` for plain reading. It drives a real browser
  and bills per step. Search and fetch cover reading tasks for free.
- Never guess or invent URLs. Search first when the address is unknown.
- Never run more than 3 searches in a row. Read the results and reassess before
  the next search. The service allows 30 searches per minute.
- Never fetch more pages than the answer needs. Every page adds context cost.
- If a command fails with an auth error, run `tinyfish auth status` and report
  the result. Do not run `tinyfish auth login` or `tinyfish auth set` on your
  own.
