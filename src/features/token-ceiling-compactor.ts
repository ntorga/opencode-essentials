import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { EssentialsConfig } from "../documents/essentialsDocument.ts"
import { newDefaultEssentialsConfig } from "../documents/essentialsDocument.ts"
import { writeLog } from "../log.ts"
import {
  isFeatureEnabled,
  logEssentialsConfigReadFailure,
  readEssentialsConfig,
  resolveEffectiveTokenCeiling,
} from "../state.ts"
import type { ContextTokens } from "../valueObject/contextTokens.ts"
import {
  DEFAULT_TOKEN_CEILING,
  MAX_TOKEN_CEILING,
  newContextTokens,
} from "../valueObject/contextTokens.ts"
import type { FeatureId } from "../valueObject/featureId.ts"
import type { ModelRef } from "../valueObject/modelRef.ts"
import type { SessionId } from "../valueObject/sessionId.ts"
import { newSessionId } from "../valueObject/sessionId.ts"
import {
  clampCeilingToModel,
  resolveCeilingTurn,
  resolveProviderContextLimit,
} from "./contextCeiling.ts"
import type { FeatureContext, ServerSuiteFeature } from "./feature.ts"
import { logRejectedHostId as logRejectedHostIdEvent } from "./hostEventRejections.ts"
import { CLIENT_REQUEST_DEADLINE_MS } from "./requestDeadline.ts"
import { requestSummarize, type SummarizeResult } from "./sessionSummarizer.ts"

const tokenCeilingCompactorId: FeatureId =
  "token-ceiling-compactor" as FeatureId

type CeilingSessionState = {
  // The compaction turn echoes its own busy/idle pair without an origin
  // field; only chat.message reopens the period (see idle-auto-compactor.ts
  // for the full reasoning). This feature additionally needs the settle to
  // stop a loop: a summary that still sits above the ceiling would
  // otherwise re-trigger compaction forever.
  isSettledThisIdlePeriod: boolean
}

type CeilingTracker = {
  client: PluginInput["client"]
  defaultCeiling: ContextTokens
  sessions: Map<SessionId, CeilingSessionState>
  cachedConfig: EssentialsConfig
  isDisposed: boolean
}

type CeilingDecision = {
  isEnabled: boolean
  ceilingTokens: ContextTokens
  readFailure?: unknown
}

function ceilingDecisionBuilder(
  tracker: CeilingTracker,
  config: EssentialsConfig,
  readFailure?: unknown,
): CeilingDecision {
  return {
    isEnabled: isFeatureEnabled(config, tokenCeilingCompactorId),
    ceilingTokens: resolveEffectiveTokenCeiling(
      config,
      tokenCeilingCompactorId,
      tracker.defaultCeiling,
    ),
    readFailure,
  }
}

function resolveCeilingDecision(tracker: CeilingTracker): CeilingDecision {
  const configRead = readEssentialsConfig()
  if (configRead.error) {
    return ceilingDecisionBuilder(
      tracker,
      tracker.cachedConfig,
      configRead.error,
    )
  }
  tracker.cachedConfig = configRead.config
  return ceilingDecisionBuilder(tracker, configRead.config)
}

async function logSummarizeResult(
  client: PluginInput["client"],
  sessionId: SessionId,
  result: SummarizeResult,
) {
  if (result.kind === "rejected") {
    await writeLog(client, "warn", "CeilingCompactionRejected", {
      sessionId,
      error: result.errorText,
    })
    return
  }
  if (result.kind === "failed") {
    await writeLog(client, "warn", "CeilingCompactionFailed", {
      sessionId,
      error: result.errorText,
    })
    return
  }
  await writeLog(client, "info", "CeilingCompactionCompleted", { sessionId })
}

// A client call that throws — a wedged server, a rejected promise — must
// not escape into the event fan-out, where it would skip every later
// feature's handler. Each read maps a throw to the same failure log as an
// error response and abandons this turn's check.
async function readTurn(tracker: CeilingTracker, sessionId: SessionId) {
  try {
    const messagesResponse = await tracker.client.session.messages({
      path: { id: sessionId },
      signal: AbortSignal.timeout(CLIENT_REQUEST_DEADLINE_MS),
    })
    if (messagesResponse.error || !messagesResponse.data) {
      await writeLog(tracker.client, "warn", "CeilingMessagesReadFailed", {
        sessionId,
        error: JSON.stringify(
          messagesResponse.error ?? "missing response body",
        ),
      })
      return undefined
    }
    const turn = resolveCeilingTurn(messagesResponse.data)
    if (!turn) {
      await writeLog(tracker.client, "debug", "CeilingNoFinishedTurn", {
        sessionId,
      })
    }
    return turn
  } catch (failure) {
    await writeLog(tracker.client, "warn", "CeilingMessagesReadFailed", {
      sessionId,
      error: String(failure),
    })
    return undefined
  }
}

// The provider list answers "what window does this model have". A failure
// or an absent model leaves the window unknown, which keeps the requested
// ceiling in play: unknown is not small, and the host's own overflow check
// still guards the real hard limit.
async function readModelWindow(
  tracker: CeilingTracker,
  sessionId: SessionId,
  modelRef: ModelRef,
): Promise<number | undefined> {
  try {
    const providerResponse = await tracker.client.provider.list({
      signal: AbortSignal.timeout(CLIENT_REQUEST_DEADLINE_MS),
    })
    if (providerResponse.error || !providerResponse.data) {
      await writeLog(tracker.client, "warn", "CeilingProviderListFailed", {
        sessionId,
        error: JSON.stringify(
          providerResponse.error ?? "missing response body",
        ),
      })
      return undefined
    }
    const windowTokens = resolveProviderContextLimit(
      providerResponse.data,
      modelRef.providerId,
      modelRef.modelId,
    )
    if (windowTokens === undefined) {
      await writeLog(tracker.client, "debug", "CeilingModelWindowUnknown", {
        sessionId,
        modelId: modelRef.modelId,
      })
    }
    return windowTokens
  } catch (failure) {
    await writeLog(tracker.client, "warn", "CeilingProviderListFailed", {
      sessionId,
      error: String(failure),
    })
    return undefined
  }
}

async function runCeilingCheck(
  tracker: CeilingTracker,
  sessionId: SessionId,
  decision: CeilingDecision,
) {
  const turn = await readTurn(tracker, sessionId)
  if (!turn) return
  const windowTokens = await readModelWindow(tracker, sessionId, turn.model)
  const clamp = clampCeilingToModel(decision.ceilingTokens, windowTokens)
  if (clamp.clampedFrom !== undefined) {
    await writeLog(tracker.client, "warn", "CeilingClampedToModelWindow", {
      sessionId,
      modelId: turn.model.modelId,
      requested: String(clamp.clampedFrom),
      clampedTo: String(clamp.ceiling),
    })
  }
  if (turn.usageTokens < clamp.ceiling) {
    await writeLog(tracker.client, "debug", "CeilingNotReached", {
      sessionId,
      usageTokens: String(turn.usageTokens),
      ceiling: String(clamp.ceiling),
    })
    return
  }
  if (tracker.isDisposed) {
    await writeLog(tracker.client, "debug", "CeilingSkippedDisposed", {
      sessionId,
    })
    return
  }
  const summarizeResult = await requestSummarize(
    tracker.client,
    sessionId,
    turn.model,
    true,
  )
  await logSummarizeResult(tracker.client, sessionId, summarizeResult)
}

// The settle flag is assigned synchronously before any await: two idle
// events for one session must not both pass the guard and both run a check,
// and the state-file read is synchronous so no window opens. The check
// itself detaches — like the idle compactor's timer callback — because a
// stalled server read must not hold the event fan-out for other features.
async function onSessionIdle(tracker: CeilingTracker, sessionId: SessionId) {
  const existingState = tracker.sessions.get(sessionId)
  if (existingState?.isSettledThisIdlePeriod) return
  const decision = resolveCeilingDecision(tracker)
  if (!decision.isEnabled) return
  tracker.sessions.set(sessionId, { isSettledThisIdlePeriod: true })
  void runSettledCheck(tracker, sessionId, decision)
}

async function runSettledCheck(
  tracker: CeilingTracker,
  sessionId: SessionId,
  decision: CeilingDecision,
) {
  if (decision.readFailure) {
    await logEssentialsConfigReadFailure(tracker.client, decision.readFailure)
  }
  await runCeilingCheck(tracker, sessionId, decision)
}

function reopenCeilingPeriod(tracker: CeilingTracker, sessionId: SessionId) {
  const existingState = tracker.sessions.get(sessionId)
  if (existingState) existingState.isSettledThisIdlePeriod = false
}

function forgetSession(tracker: CeilingTracker, sessionId: SessionId) {
  tracker.sessions.delete(sessionId)
}

async function logRejectedSessionId(
  tracker: CeilingTracker,
  eventLabel: string,
  rejectedValue: unknown,
) {
  await logRejectedHostIdEvent(
    tracker.client,
    "CeilingEventSessionIdRejected",
    eventLabel,
    rejectedValue,
  )
}

// The plugin option is a per-project default below the built-in one; the
// state file still wins over it, exactly like the idle timeout option. A
// missing option is a silent fallback; only a present-but-invalid value is
// loud.
async function resolveCeilingOption(
  client: PluginInput["client"],
  options: Record<string, unknown>,
): Promise<ContextTokens> {
  const rawCeiling = options.ceilingTokens
  if (rawCeiling === undefined) return DEFAULT_TOKEN_CEILING
  const validCeiling = newContextTokens(rawCeiling)
  if (validCeiling === undefined) {
    await writeLog(client, "warn", "InvalidCeilingTokens", {
      rawCeiling: String(rawCeiling),
      fallbackTokens: DEFAULT_TOKEN_CEILING,
      maxTokens: MAX_TOKEN_CEILING,
    })
    return DEFAULT_TOKEN_CEILING
  }
  return validCeiling
}

async function buildHooks(context: FeatureContext): Promise<Hooks> {
  const defaultCeiling = await resolveCeilingOption(
    context.client,
    context.options,
  )
  const tracker: CeilingTracker = {
    client: context.client,
    defaultCeiling,
    sessions: new Map(),
    cachedConfig: newDefaultEssentialsConfig(),
    isDisposed: false,
  }

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.status": {
          const rawSessionId = event.properties.sessionID
          const eventSessionId = newSessionId(rawSessionId)
          if (!eventSessionId) {
            await logRejectedSessionId(tracker, event.type, rawSessionId)
            return
          }
          if (event.properties.status?.type === "idle") {
            await onSessionIdle(tracker, eventSessionId)
          }
          return
        }
        case "session.deleted": {
          const eventSessionId = newSessionId(event.properties.info?.id)
          if (!eventSessionId) {
            await logRejectedSessionId(
              tracker,
              event.type,
              event.properties.info?.id,
            )
            return
          }
          forgetSession(tracker, eventSessionId)
          return
        }
      }
    },
    "chat.message": async ({ sessionID: rawSessionId }) => {
      const messageSessionId = newSessionId(rawSessionId)
      if (!messageSessionId) {
        await logRejectedSessionId(tracker, "chat.message", rawSessionId)
        return
      }
      reopenCeilingPeriod(tracker, messageSessionId)
    },
    dispose: async () => {
      tracker.isDisposed = true
      tracker.sessions.clear()
    },
  }
}

export const tokenCeilingCompactorFeature: ServerSuiteFeature = {
  id: tokenCeilingCompactorId,
  title: "Token Ceiling Compactor",
  description:
    "Compacts a session once its context passes a token ceiling. Default 384k.",
  hasAdjustableTokenCeiling: true,
  buildHooks,
}
