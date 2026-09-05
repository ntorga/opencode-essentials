import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { FeatureContext, SuiteFeature } from "./feature.ts"
import { writeLog } from "../log.ts"
import type { EssentialsConfig } from "../valueObject/essentialsConfig.ts"
import type { FeatureId } from "../valueObject/featureId.ts"
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  type IdleTimeoutMs,
  MAX_TIMER_DELAY_MS,
  newIdleTimeoutMs,
} from "../valueObject/idleTimeoutMs.ts"
import type { ModelRef } from "../valueObject/modelRef.ts"
import type { SessionId } from "../valueObject/sessionId.ts"
import { newDefaultEssentialsConfig } from "../valueObject/essentialsConfig.ts"
import { newModelRef } from "../valueObject/modelRef.ts"
import { newSessionId } from "../valueObject/sessionId.ts"
import {
  resolveEffectiveIdleTimeoutMs,
  isFeatureEnabled,
  readEssentialsConfig,
} from "../state.ts"

const idleAutoCompactorId: FeatureId =
  "idle-auto-compactor" as FeatureId

const COMPACTION_REQUEST_DEADLINE_MS = 60 * 1000

type IdleTimer = ReturnType<typeof setTimeout>

type MessageInfo = {
  role: string
  model?: unknown
}

type SessionState = {
  timer: IdleTimer | undefined
  // OpenCode runs compaction as a prompt turn, which emits its own
  // session.status busy/idle pair. The events carry no origin field, so no
  // name or type can tell that pair from real activity; settling the period
  // when the timer fires absorbs the echo. Only chat.message, which fires
  // solely on genuine prompts, reopens the period.
  isSettledThisIdlePeriod: boolean
}

type IdleTracker = {
  client: PluginInput["client"]
  defaultIdleTimeoutMs: IdleTimeoutMs
  sessions: Map<SessionId, SessionState>
  cachedConfig: EssentialsConfig
  isDisposed: boolean
}

type CompactorDecision = {
  isEnabled: boolean
  idleTimeoutMs: IdleTimeoutMs
  readFailure?: unknown
  clampedFrom?: IdleTimeoutMs
}

function readLastUserMessage(
  messages: Array<{ info: MessageInfo }>,
): MessageInfo | undefined {
  for (let position = messages.length - 1; position >= 0; position--) {
    if (messages[position].info.role === "user") {
      return messages[position].info
    }
  }
  return undefined
}

async function compactSession(tracker: IdleTracker, sessionId: SessionId) {
  try {
    const sessionMessages = await tracker.client.session.messages({
      path: { id: sessionId },
      signal: AbortSignal.timeout(COMPACTION_REQUEST_DEADLINE_MS),
    })
    if (sessionMessages.error || !sessionMessages.data) {
      await writeLog(
        tracker.client,
        "warn",
        "IdleCompactionMessagesReadFailed",
        {
          sessionId,
          error: JSON.stringify(
            sessionMessages.error ?? "missing response body",
          ),
        },
      )
      return
    }
    const lastUserMessage = readLastUserMessage(sessionMessages.data)
    const modelRef = lastUserMessage
      ? newModelRef(lastUserMessage.model)
      : undefined
    if (!modelRef) {
      const isMalformedModel =
        lastUserMessage !== undefined && lastUserMessage.model !== undefined
      const skipKey = isMalformedModel
        ? "IdleCompactionModelRejected"
        : "IdleCompactionSkippedNoModel"
      await writeLog(
        tracker.client,
        isMalformedModel ? "warn" : "debug",
        skipKey,
        { sessionId },
      )
      return
    }
    if (tracker.isDisposed) {
      await writeLog(tracker.client, "debug", "IdleCompactionSkippedDisposed", {
        sessionId,
      })
      return
    }
    const summarizeResponse = await tracker.client.session.summarize({
      path: { id: sessionId },
      body: { providerID: modelRef.providerId, modelID: modelRef.modelId },
      signal: AbortSignal.timeout(COMPACTION_REQUEST_DEADLINE_MS),
    })
    if (summarizeResponse.error) {
      await writeLog(tracker.client, "warn", "IdleCompactionRejected", {
        sessionId,
        error: JSON.stringify(summarizeResponse.error),
      })
      return
    }
    await writeLog(tracker.client, "info", "IdleCompactionCompleted", {
      sessionId,
    })
  } catch (failure) {
    await writeLog(tracker.client, "warn", "IdleCompactionFailed", {
      sessionId,
      error: String(failure),
    })
  }
}

function resolveCompactorDecision(tracker: IdleTracker): CompactorDecision {
  const configRead = readEssentialsConfig()
  if (configRead.error) {
    return compactorDecisionBuilder(tracker, tracker.cachedConfig, configRead.error)
  }
  tracker.cachedConfig = configRead.config
  return compactorDecisionBuilder(tracker, configRead.config)
}

function compactorDecisionBuilder(
  tracker: IdleTracker,
  config: EssentialsConfig,
  readFailure?: unknown,
): CompactorDecision {
  const wantedTimeoutMs = resolveEffectiveIdleTimeoutMs(
    config,
    idleAutoCompactorId,
    tracker.defaultIdleTimeoutMs,
  )
  const isClamped = wantedTimeoutMs > MAX_TIMER_DELAY_MS
  const decision: CompactorDecision = {
    isEnabled: isFeatureEnabled(config, idleAutoCompactorId),
    idleTimeoutMs: isClamped ? MAX_TIMER_DELAY_MS : wantedTimeoutMs,
    readFailure: readFailure,
  }
  if (isClamped) decision.clampedFrom = wantedTimeoutMs
  return decision
}

async function logEssentialsConfigReadFailure(
  tracker: IdleTracker,
  readFailure: unknown,
) {
  await writeLog(tracker.client, "warn", "EssentialsConfigReadFailed", {
    error: String(readFailure),
  })
}

async function logIdleTimeoutClamped(
  tracker: IdleTracker,
  clampedFrom: IdleTimeoutMs,
) {
  await writeLog(tracker.client, "warn", "IdleTimeoutMsClamped", {
    clampedFrom: String(clampedFrom),
    clampedMs: MAX_TIMER_DELAY_MS,
  })
}

function ensureSessionState(
  tracker: IdleTracker,
  sessionId: SessionId,
): SessionState {
  const existingState = tracker.sessions.get(sessionId)
  if (existingState) return existingState
  const freshState: SessionState = {
    timer: undefined,
    isSettledThisIdlePeriod: false,
  }
  tracker.sessions.set(sessionId, freshState)
  return freshState
}

function cancelIdleTimer(tracker: IdleTracker, sessionId: SessionId) {
  const state = tracker.sessions.get(sessionId)
  if (!state) return
  if (state.timer) clearTimeout(state.timer)
  state.timer = undefined
}

// The guard and the timer assignment must not span an await: two idle events
// for one session could otherwise both pass the guard and both arm, and the
// second arm would orphan the first timer. The state-file read is
// synchronous, so the window cannot open; only the failure log awaits, and
// it runs after the assignment.
async function armIdleTimer(tracker: IdleTracker, sessionId: SessionId) {
  const state = ensureSessionState(tracker, sessionId)
  if (state.timer || state.isSettledThisIdlePeriod) return
  const decision = resolveCompactorDecision(tracker)
  if (decision.isEnabled) {
    state.timer = setTimeout(
      () => void startCompaction(tracker, sessionId),
      decision.idleTimeoutMs,
    )
  }
  if (decision.readFailure) {
    await logEssentialsConfigReadFailure(tracker, decision.readFailure)
  }
  if (decision.clampedFrom !== undefined) {
    await logIdleTimeoutClamped(tracker, decision.clampedFrom)
  }
}

async function startCompaction(tracker: IdleTracker, sessionId: SessionId) {
  const state = ensureSessionState(tracker, sessionId)
  state.timer = undefined
  if (state.isSettledThisIdlePeriod) return
  const decision = resolveCompactorDecision(tracker)
  const shouldSettlePeriod = decision.isEnabled
  state.isSettledThisIdlePeriod = shouldSettlePeriod
  if (!shouldSettlePeriod) return
  if (decision.readFailure) {
    await logEssentialsConfigReadFailure(tracker, decision.readFailure)
  }
  await compactSession(tracker, sessionId)
}

function forgetSession(tracker: IdleTracker, sessionId: SessionId) {
  if (!tracker.sessions.has(sessionId)) return
  cancelIdleTimer(tracker, sessionId)
  tracker.sessions.delete(sessionId)
}

function reopenIdlePeriod(tracker: IdleTracker, sessionId: SessionId) {
  cancelIdleTimer(tracker, sessionId)
  ensureSessionState(tracker, sessionId).isSettledThisIdlePeriod = false
}

async function resolveIdleTimeoutMs(
  client: PluginInput["client"],
  options: Record<string, unknown>,
): Promise<IdleTimeoutMs> {
  const rawTimeout = options.idleTimeoutMs
  if (rawTimeout === undefined) return DEFAULT_IDLE_TIMEOUT_MS
  const validTimeout = newIdleTimeoutMs(rawTimeout)
  if (validTimeout === undefined) {
    await writeLog(client, "warn", "InvalidIdleTimeoutMs", {
      rawTimeout: String(rawTimeout),
      fallbackMs: DEFAULT_IDLE_TIMEOUT_MS,
    })
    return DEFAULT_IDLE_TIMEOUT_MS
  }
  if (validTimeout > MAX_TIMER_DELAY_MS) {
    await writeLog(client, "warn", "IdleTimeoutMsClamped", {
      rawTimeout: String(rawTimeout),
      clampedMs: MAX_TIMER_DELAY_MS,
    })
    return MAX_TIMER_DELAY_MS
  }
  return validTimeout
}

// A rejected id is a protocol violation, not routine noise: warn once per
// event so a pattern drift between OpenCode and this guard surfaces in the
// log instead of silently disabling the feature.
async function logRejectedSessionId(
  tracker: IdleTracker,
  eventLabel: string,
  rejectedValue: unknown,
) {
  await writeLog(tracker.client, "warn", "IdleEventSessionIdRejected", {
    event: eventLabel,
    rejectedValue: String(rejectedValue),
  })
}

async function buildHooks(context: FeatureContext): Promise<Hooks> {
  const defaultIdleTimeoutMs = await resolveIdleTimeoutMs(
    context.client,
    context.options,
  )
  const tracker: IdleTracker = {
    client: context.client,
    defaultIdleTimeoutMs,
    sessions: new Map(),
    cachedConfig: newDefaultEssentialsConfig(),
    isDisposed: false,
  }

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.status": {
          const rawSessionId = event.properties.sessionID
          const status = event.properties.status
          const eventSessionId = newSessionId(rawSessionId)
          if (!eventSessionId) {
            await logRejectedSessionId(tracker, event.type, rawSessionId)
            return
          }
          if (!status) return
          if (status.type === "idle") {
            await armIdleTimer(tracker, eventSessionId)
          }
          if (status.type === "busy") cancelIdleTimer(tracker, eventSessionId)
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
      reopenIdlePeriod(tracker, messageSessionId)
    },
    dispose: async () => {
      tracker.isDisposed = true
      for (const sessionId of [...tracker.sessions.keys()]) {
        forgetSession(tracker, sessionId)
      }
    },
  }
}

export const idleAutoCompactorFeature: SuiteFeature = {
  id: idleAutoCompactorId,
  title: "Idle Auto Compactor",
  description:
    "Compacts a session after it stays continuously idle. Default 30 minutes.",
  hasAdjustableIdleTimeout: true,
  buildHooks,
}
