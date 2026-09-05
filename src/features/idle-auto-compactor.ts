import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { FeatureContext, SuiteFeature } from "./feature.ts"
import { writeLog } from "../log.ts"
import type { FeatureStates } from "../state.ts"
import { isFeatureEnabled, readFeatureStates } from "../state.ts"

const IDLE_AUTO_COMPACTOR_ID = "idle-auto-compactor"

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000

// Node silently clamps setTimeout delays above 2^31-1 ms to 1 ms. No type
// absorbs that stdlib contract, so resolveIdleTimeoutMs clamps explicitly.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

const COMPACTION_REQUEST_DEADLINE_MS = 60 * 1000

// OpenCode session ids are ASCII tokens; anything else must not reach a URL
// path segment. The SDK percent-encodes "/" but not ".", and Request
// normalizes "..", so a raw segment could redirect the call to a sibling
// endpoint. No type absorbs this external contract; the guard enforces it.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

type IdleTimer = ReturnType<typeof setTimeout>

type SessionModel = {
  providerID: string
  modelID: string
}

type MessageInfo = {
  role: string
  model?: Partial<SessionModel>
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
  idleTimeoutMs: number
  sessions: Map<string, SessionState>
  cachedFeatureStates: FeatureStates
  isDisposed: boolean
}

type CompactorDecision = {
  isEnabled: boolean
  readFailure?: unknown
}

function lastUserMessageOf(
  messages: Array<{ info: MessageInfo }>,
): MessageInfo | undefined {
  for (let position = messages.length - 1; position >= 0; position--) {
    if (messages[position].info.role === "user") {
      return messages[position].info
    }
  }
  return undefined
}

function modelFromUserMessage(
  userMessage: MessageInfo,
): SessionModel | undefined {
  const providerID = userMessage.model?.providerID
  const modelID = userMessage.model?.modelID
  if (providerID && modelID) return { providerID, modelID }
  return undefined
}

async function compactSession(tracker: IdleTracker, sessionID: string) {
  try {
    const sessionMessages = await tracker.client.session.messages({
      path: { id: sessionID },
      signal: AbortSignal.timeout(COMPACTION_REQUEST_DEADLINE_MS),
    })
    if (sessionMessages.error || !sessionMessages.data) {
      await writeLog(tracker.client, "warn", "IdleCompactionMessagesReadFailed", {
        sessionID,
        error: JSON.stringify(sessionMessages.error ?? "missing response body"),
      })
      return
    }
    const lastUser = lastUserMessageOf(sessionMessages.data)
    const model = lastUser ? modelFromUserMessage(lastUser) : undefined
    if (!model) {
      await writeLog(tracker.client, "debug", "IdleCompactionSkippedNoModel", {
        sessionID,
      })
      return
    }
    if (tracker.isDisposed) {
      await writeLog(tracker.client, "debug", "IdleCompactionSkippedDisposed", {
        sessionID,
      })
      return
    }
    const summarizeResult = await tracker.client.session.summarize({
      path: { id: sessionID },
      body: { providerID: model.providerID, modelID: model.modelID },
      signal: AbortSignal.timeout(COMPACTION_REQUEST_DEADLINE_MS),
    })
    if (summarizeResult.error) {
      await writeLog(tracker.client, "warn", "IdleCompactionRejected", {
        sessionID,
        error: JSON.stringify(summarizeResult.error),
      })
      return
    }
    await writeLog(tracker.client, "info", "IdleCompactionCompleted", {
      sessionID,
    })
  } catch (failure) {
    await writeLog(tracker.client, "warn", "IdleCompactionFailed", {
      sessionID,
      error: String(failure),
    })
  }
}

function readCompactorDecision(tracker: IdleTracker): CompactorDecision {
  const read = readFeatureStates()
  if (read.error) {
    const cached = isFeatureEnabled(
      tracker.cachedFeatureStates,
      IDLE_AUTO_COMPACTOR_ID,
    )
    return { isEnabled: cached, readFailure: read.error }
  }
  tracker.cachedFeatureStates = read.states
  return { isEnabled: isFeatureEnabled(read.states, IDLE_AUTO_COMPACTOR_ID) }
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
  sessionID: string,
): SessionState {
  const existing = tracker.sessions.get(sessionID)
  if (existing) return existing
  const fresh: SessionState = {
    timer: undefined,
    isSettledThisIdlePeriod: false,
  }
  tracker.sessions.set(sessionID, fresh)
  return fresh
}

function cancelIdleTimer(tracker: IdleTracker, sessionID: string) {
  const state = tracker.sessions.get(sessionID)
  if (!state) return
  if (state.timer) clearTimeout(state.timer)
  state.timer = undefined
}

// The guard and the timer assignment must not span an await: two idle events
// for one session could otherwise both pass the guard and both arm, and the
// second arm would orphan the first timer. The state-file read is
// synchronous, so the window cannot open; only the failure log awaits, and
// it runs after the assignment.
async function armIdleTimer(tracker: IdleTracker, sessionID: string) {
  const state = ensureSessionState(tracker, sessionID)
  if (state.timer || state.isSettledThisIdlePeriod) return
  const decision = readCompactorDecision(tracker)
  if (decision.isEnabled) {
    state.timer = setTimeout(
      () => void startCompaction(tracker, sessionID),
      tracker.idleTimeoutMs,
    )
  }
  if (decision.readFailure) {
    await logFeatureStatesReadFailure(tracker, decision.readFailure)
  }
}

async function startCompaction(tracker: IdleTracker, sessionID: string) {
  const state = ensureSessionState(tracker, sessionID)
  state.timer = undefined
  if (state.isSettledThisIdlePeriod) return
  const decision = readCompactorDecision(tracker)
  state.isSettledThisIdlePeriod = decision.isEnabled
  if (!decision.isEnabled) return
  if (decision.readFailure) {
    await logFeatureStatesReadFailure(tracker, decision.readFailure)
  }
  await compactSession(tracker, sessionID)
}

function forgetSession(tracker: IdleTracker, sessionID: string) {
  if (!tracker.sessions.has(sessionID)) return
  cancelIdleTimer(tracker, sessionID)
  tracker.sessions.delete(sessionID)
}

function reopenIdlePeriod(tracker: IdleTracker, sessionID: string) {
  cancelIdleTimer(tracker, sessionID)
  ensureSessionState(tracker, sessionID).isSettledThisIdlePeriod = false
}

function isUsableSessionID(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value)
}

function isPositiveDurationMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

async function resolveIdleTimeoutMs(
  client: PluginInput["client"],
  options: Record<string, unknown>,
): Promise<number> {
  const configured = options.idleTimeoutMs
  if (configured === undefined) return DEFAULT_IDLE_TIMEOUT_MS
  if (!isPositiveDurationMs(configured)) {
    await writeLog(client, "warn", "InvalidIdleTimeoutMs", {
      configured: String(configured),
      fallbackMs: DEFAULT_IDLE_TIMEOUT_MS,
    })
    return DEFAULT_IDLE_TIMEOUT_MS
  }
  if (configured > MAX_TIMER_DELAY_MS) {
    await writeLog(client, "warn", "IdleTimeoutMsClamped", {
      configured: String(configured),
      clampedMs: MAX_TIMER_DELAY_MS,
    })
    return MAX_TIMER_DELAY_MS
  }
  return configured
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
          const { sessionID, status } = event.properties
          if (!isUsableSessionID(sessionID) || !status) return
          if (status.type === "idle") await armIdleTimer(tracker, sessionID)
          if (status.type === "busy") cancelIdleTimer(tracker, sessionID)
          return
        }
        case "session.deleted": {
          const sessionID = event.properties.info?.id
          if (isUsableSessionID(sessionID)) forgetSession(tracker, sessionID)
          return
        }
      }
    },
    "chat.message": async ({ sessionID }) => {
      if (isUsableSessionID(sessionID)) reopenIdlePeriod(tracker, sessionID)
    },
    dispose: async () => {
      tracker.isDisposed = true
      for (const sessionID of [...tracker.sessions.keys()]) {
        forgetSession(tracker, sessionID)
      }
    },
  }
}

export const idleAutoCompactorFeature: SuiteFeature = {
  id: IDLE_AUTO_COMPACTOR_ID,
  title: "Idle Auto Compactor",
  description:
    "Compacts a session after it stays continuously idle. Default 30 minutes.",
  buildHooks,
}
