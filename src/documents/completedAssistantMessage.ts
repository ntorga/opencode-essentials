import type { MessageId } from "../valueObject/messageId.ts"
import { newMessageId } from "../valueObject/messageId.ts"
import type { TimestampMs } from "../valueObject/timestampMs.ts"
import { newTimestampMs } from "../valueObject/timestampMs.ts"
import type { TokenCount } from "../valueObject/tokenCount.ts"
import { newTokenCount } from "../valueObject/tokenCount.ts"
import { isRecord } from "../valueObject/util.ts"
import type { ParsedDocument } from "./util.ts"
import { newParsedDocument } from "./util.ts"

type CompletedAssistantMessageFields = {
  id: MessageId
  createdAtMs: TimestampMs
  completedAtMs: TimestampMs
  outputTokens: TokenCount
  reasoningTokens: TokenCount
}

export type CompletedAssistantMessage = ParsedDocument<
  CompletedAssistantMessageFields,
  "assistantMessage"
>

// OpenCode hands completed assistant messages to the plugin as event
// payloads. A message without a finished clock or without output tokens
// cannot join the response window, so any half-interpretable payload is
// dropped as a whole.
export function newCompletedAssistantMessage(
  rawMessage: unknown,
): CompletedAssistantMessage | undefined {
  if (!isRecord(rawMessage) || rawMessage.role !== "assistant") return undefined
  if (rawMessage.summary === true) return undefined
  const id = newMessageId(rawMessage.id)
  if (!id || !isRecord(rawMessage.time) || !isRecord(rawMessage.tokens)) {
    return undefined
  }

  const createdAtMs = newTimestampMs(rawMessage.time.created)
  const completedAtMs = newTimestampMs(rawMessage.time.completed)
  const outputTokens = newTokenCount(rawMessage.tokens.output)
  const reasoningTokens = newTokenCount(rawMessage.tokens.reasoning ?? 0)
  if (
    createdAtMs === undefined ||
    completedAtMs === undefined ||
    completedAtMs <= createdAtMs ||
    outputTokens === undefined ||
    outputTokens === 0 ||
    reasoningTokens === undefined
  ) {
    return undefined
  }

  return newParsedDocument<CompletedAssistantMessageFields, "assistantMessage">(
    { id, createdAtMs, completedAtMs, outputTokens, reasoningTokens },
  )
}
