---
name: humanizer
description: Use /humanizer to rewrite text or review prose for AI writing patterns while preserving the writer's claims and voice.
license: MIT
metadata:
  source: global-humanizer
  version: "3.0.0"
---

# Humanizer

Rewrite text so it sounds like its writer. Keep every supported claim. Do not
add facts, names, numbers, dates, quotes, or citations.

## Procedure

1. Read the full text once. Mark patterns in sentence and paragraph structure.
2. Rewrite the text around its main point. Do not patch one phrase at a time.
3. Check that the rewrite keeps the source's meaning and details.
4. Remove any pattern that still distracts from the writer's point.

## Strong patterns

Act on one clear example of these patterns:

- **Staging:** A contrast adds emphasis without adding information. A sentence
  announces importance instead of stating the point. A closing line repeats
  the paragraph.
- **Fake objections:** The text rejects an option that no one raised. State
  the useful claim without the defense.
- **Inflated claims:** Ordinary facts sound pivotal, expert-backed, or
  groundbreaking without evidence. Keep the fact and remove the claim.
- **Vague links:** The text says two things are connected without explaining
  how. Name the relationship only when the source supports it.
- **Chat residue:** Remove greetings, praise, offers to continue, and closers
  such as "I hope this helps." Keep the useful answer.
- **Decorative formatting:** Remove bold labels, title case headings, emojis,
  and rules when they add no meaning.
- **Knowledge disclaimers:** State what the source does not show. Do not fill
  gaps with guesses.

## Patterns that need context

One instance may be deliberate. Edit these when several appear together:

- Three examples forced into a list.
- Repeated sentence openings.
- Em or en dashes used to connect unrelated clauses.
- Stacked qualifiers that hide a supported claim.
- Passive voice that hides the actor.
- Hyphenated pairs used in every sentence.
- Long substitutes for simple verbs such as "is" or "has."

Do not edit a watched phrase inside a quotation, title, name, or text that
discusses the phrase itself. Keep a pattern when the writer uses it on purpose
and it helps the meaning.

## Voice and meaning

- Follow a writing sample when the user provides one.
- Keep opinions, uncertainty, humor, and unusual details when they belong to
  the writer.
- Keep technical and factual text plain and neutral.
- Do not add a fact to make a sentence sound complete. Ask for the detail or
  simplify the sentence.
- Do not rewrite code, commands, paths, URLs, data, or metadata.

## Output

For pasted text, return the final rewrite. Add a short note about important
changes only when the user asks for an explanation.

For a named file, change prose only. Keep code blocks, inline code, commands,
paths, YAML metadata, data, and link targets unchanged. Then give a short
summary.

The pattern list draws on Wikipedia's [Signs of AI
writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).
