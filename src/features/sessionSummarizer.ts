import type { PluginInput } from "@opencode-ai/plugin"
import type { ModelRef } from "../valueObject/modelRef.ts"
import type { SessionId } from "../valueObject/sessionId.ts"
import { CLIENT_REQUEST_DEADLINE_MS } from "./requestDeadline.ts"

// The outcome of one summarize request, without any feature's log keys
// attached: the caller turns it into its own searchable log message.
export type SummarizeResult =
  | { kind: "summarized" }
  | { kind: "rejected"; errorText: string }
  | { kind: "failed"; errorText: string }

// OpenCode's compaction contract: session.summarize with the provider and
// model of the turn to compact. A rejected request carries the server's
// error body; a thrown one is a transport or deadline failure.
export async function requestSummarize(
  client: PluginInput["client"],
  sessionId: SessionId,
  modelRef: ModelRef,
  autoContinue: boolean,
): Promise<SummarizeResult> {
  try {
    const summarizeBody = {
      providerID: modelRef.providerId,
      modelID: modelRef.modelId,
      auto: autoContinue,
    }
    const summarizeResponse = await client.session.summarize({
      path: { id: sessionId },
      body: summarizeBody,
      signal: AbortSignal.timeout(CLIENT_REQUEST_DEADLINE_MS),
    })
    if (summarizeResponse.error) {
      return {
        kind: "rejected",
        errorText: JSON.stringify(summarizeResponse.error),
      }
    }
    return { kind: "summarized" }
  } catch (failure) {
    return { kind: "failed", errorText: String(failure) }
  }
}
