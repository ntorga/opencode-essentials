---
name: web-search
description: Use /web-search for current facts, external systems, or public tools. Search, fetch the needed content, and cite sources.
metadata:
  source: ai-framework-web-search
  version: "0.1.0"
---

# Web search

Use local files and conversation context first. Skip web search when they
answer the question.

## Search

Use the TinyFish CLI when you do not know the right page:

```bash
tinyfish search query "your question"
```

Do not run more than three searches in a row. Read the results before the next
search. Search results include a title, URL, and summary. Fetch only pages
that need more detail.

## Fetch

Use the native `webfetch` tool when you know the page URL. If it fails or
returns no content, use:

```bash
tinyfish fetch content get "https://example.com/page"
```

One TinyFish fetch can read up to ten URLs. The results include the final URL
and extracted text. Check for failed URLs.

## Report

Cite the URL for each external fact. Do not state facts that the sources do
not support. Use search when the right page is unknown. Do not guess URLs.

Never use `tinyfish agent run` for reading. It opens a live browser. Search and
fetch are enough for research. If TinyFish reports an authentication error,
check `tinyfish auth status`. Do not log in or change credentials.
