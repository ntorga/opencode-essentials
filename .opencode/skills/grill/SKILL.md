---
name: grill
description: Use when a user asks for /grill or wants to stress-test a plan, decision, or idea. Ask only questions about decisions that are hard to revert or cause rework, in short rounds, capped at 30 questions.
---

# Grill

## Purpose

A plan carries decisions the author never examined. An interview surfaces them
before code locks them in. The interview costs the user attention, so it asks
only about decisions that are hard to revert or that force rework when wrong.
Cheap, reversible decisions belong to the implementer, not to an interview. A
cap of 30 questions bounds the session; the meaning test does the real
filtering.

## Procedure

1. **State the goal.** Write the goal in one sentence. The interview tests
   whether the plan reaches that sentence.
2. **Separate settled facts from open decisions.** Facts are already true or
   discoverable; decisions need the user. Find facts with tools instead of
   asking the user for them.
3. **Filter the decisions by cost of being wrong.** Keep a decision only when
   reversing it later is hard, or a wrong answer forces rework: data models,
   public APIs, auth boundaries, migrations, external contracts, irreversible
   user-visible behavior. Name each kept decision and the rework a wrong answer
   causes. Drop the rest; the implementer decides those alone.
4. **Ask one round.** Put up to three kept decisions to the user in one
   message. State a recommendation when the answer has a real trade-off, and
   put the recommended option first.

   ```text
   Q1. <Decision>: <Question and useful choices>

   Recommendation: <Best option and reason>
   ```

5. **Wait for the answers.** The answers decide the next questions. A settled
   answer can unblock a decision that depended on it. Number questions across
   the whole interview.
6. **Stop at the cap.** Stop after 30 questions total. If decisions remain
   open, list them as assumptions. Do not ask more questions.
7. **Close on confirmation.** When the decisions are clear, summarize them and
   ask the user to confirm the shared understanding.

## Guardrails

- Never ask a question a tool or a project file can answer. Find the fact
  yourself.
- Never ask about a decision that is easy to revert and cheap to redo. Decide
  it during implementation and move on.
- Never ask a question that does not name the rework a wrong answer causes.
  No named rework, no question.
- Never act before the user confirms the summary. The interview ends in shared
  understanding, not in code.
- Never exceed 30 questions. An open decision past the cap becomes a stated
  assumption.
