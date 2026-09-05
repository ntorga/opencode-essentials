import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { FeatureContext, SuiteFeature } from "./feature.ts"
import { writeLog } from "../log.ts"
import type { FeatureId } from "../valueObject/featureId.ts"
import type { FeatureStates } from "../valueObject/featureStates.ts"
import type { IdleTimeoutMs } from "../valueObject/idleTimeoutMs.ts"
import type { ModelRef } from "../valueObject/modelRef.ts"
import type { SessionId } from "../valueObject/sessionId.ts"
import { newIdleTimeoutMs } from "../valueObject/idleTimeoutMs.ts"
import { newModelRef } from "../valueObject/modelRef.ts"
import { newSessionId } from "../valueObject/sessionId.ts"
import { isFeatureEnabled, readFeatureStates } from "../state.ts"

const idleAutoCompactorId: FeatureId =
  "idle-auto-compactor" as FeatureId

const DEFAULT_IDLE_TIMEOUT_MS: IdleTimeoutMs =
  (30 * 60 * 1000) as IdleTimeoutMs

// Node silently clamps setTimeout delays above 2^31-1 ms to 1 ms. No type
// absorbs that stdlib contract, so resolveIdleTimeoutMs clamps explicitly.
const MAX_TIMER_DELAY_MS: IdleTimeoutMs =
  (2 ** 31 - 1) as IdleTimeoutMs

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
  idleTimeoutMs: IdleTimeoutMs
  sessions: Map<SessionId, SessionState>
  cachedFeatureStates: FeatureStates
  isDisposed: boolean
}

type CompactorDecision = {
  isEnabled: boolean
  readFailure?: unknown
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

function readCompactorDecision(tracker: IdleTracker): CompactorDecision {
  const statesRead = readFeatureStates()
  if (statesRead.error) {
    const lastKnownEnabled = isFeatureEnabled(
      tracker.cachedFeatureStates,
      idleAutoCompactorId,
    )
    return { isEnabled: lastKnownEnabled, readFailure: statesRead.error }
  }
  tracker.cachedFeatureStates = statesRead.states
  return {
    isEnabled: isFeatureEnabled(statesRead.states, idleAutoCompactorId),
  }
}

async function logFeatureStatesReadFailure(
  tracker: IdleTracker,
  readFailure: unknown,
) {
  await writeLog(tracker.client, "warn", "FeatureStatesReadFailed", {
    error: String(readFailure),
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
  const decision = readCompactorDecision(tracker)
  if (decision.isEnabled) {
    state.timer = setTimeout(
      () => void startCompaction(tracker, sessionId),
      tracker.idleTimeoutMs,
    )
  }
  if (decision.readFailure) {
    await logFeatureStatesReadFailure(tracker, decision.readFailure)
  }
}

async function startCompaction(tracker: IdleTracker, sessionId: SessionId) {
  const state = ensureSessionState(tracker, sessionId)
  state.timer = undefined
  if (state.isSettledThisIdlePeriod) return
  const decision = readCompactorDecision(tracker)
  state.isSettledThisIdlePeriod = decision.isEnabled
  if (!decision.isEnabled) return
  if (decision.readFailure) {
    await logFeatureStatesReadFailure(tracker, decision.readFailure)
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
  const idleTimeoutMs = await resolveIdleTimeoutMs(
    context.client,
    context.options,
  )
  const tracker: IdleTracker = {
    client: context.client,
    idleTimeoutMs,
    sessions: new Map(),
    cachedFeatureStates: {},
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
  buildHooks,
}
