import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { FeatureContext, SuiteFeature } from "./feature.ts"
import { writeLog } from "../log.ts"
import type { FeatureStates } from "../state.ts"
import { isFeatureEnabled, readFeatureStates } from "../state.ts"

const IDLE_AUTO_COMPACTOR_ID = "idle-auto-compactor"

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000

// Node clamps setTimeout delays above 2^31-1 ms to 1 ms. The only structure
// that can express that ceiling is this constant, so the config value is
// clamped to it rather than passed through.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

type IdleTimer = ReturnType<typeof setTimeout>

type SessionModel = {
  providerID: string
  modelID: string
}

type SessionState = {
  timer: IdleTimer | undefined
  // OpenCode runs compaction as a prompt turn, which emits its own
  // session.status busy/idle pair. The events carry no origin, so no code
  // can tell that pair from real activity; settling the period when the
  // timer fires absorbs the echo. Only chat.message, which fires solely on
  // genuine prompts, reopens the period.
  isSettledThisIdlePeriod: boolean
}

type IdleTracker = {
  client: PluginInput["client"]
  idleTimeoutMs: number
  sessions: Map<string, SessionState>
  cachedFeatureStates: FeatureStates
}

function isPositiveDurationMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function readLastUserModel(
  messages: Array<{
    info: { role: string; model?: Partial<SessionModel> }
  }>,
): SessionModel | undefined {
  for (let position = messages.length - 1; position >= 0; position--) {
    const info = messages[position].info
    if (info.role !== "user") continue
    const providerID = info.model?.providerID
    const modelID = info.model?.modelID
    if (providerID && modelID) return { providerID, modelID }
    return undefined
  }
  return undefined
}

async function isCompactorEnabled(tracker: IdleTracker): Promise<boolean> {
  const read = readFeatureStates()
  if (read.error) {
    await writeLog(tracker.client, "warn", "FeatureStatesReadFailed", {
      error: String(read.error),
    })
    return isFeatureEnabled(tracker.cachedFeatureStates, IDLE_AUTO_COMPACTOR_ID)
  }
  tracker.cachedFeatureStates = read.states
  return isFeatureEnabled(read.states, IDLE_AUTO_COMPACTOR_ID)
}

async function compactSession(tracker: IdleTracker, sessionID: string) {
  try {
    const sessionMessages = await tracker.client.session.messages({
      path: { id: sessionID },
    })
    if (sessionMessages.error || !sessionMessages.data) {
      await writeLog(
        tracker.client,
        "warn",
        "IdleCompactionMessagesReadFailed",
        {
          sessionID,
          error: JSON.stringify(
            sessionMessages.error ?? "missing response body",
          ),
        },
      )
      return
    }
    const model = readLastUserModel(sessionMessages.data)
    if (!model) {
      await writeLog(tracker.client, "debug", "IdleCompactionSkippedNoModel", {
        sessionID,
      })
      return
    }
    const summarizeResult = await tracker.client.session.summarize({
      path: { id: sessionID },
      body: { providerID: model.providerID, modelID: model.modelID },
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

async function startCompaction(tracker: IdleTracker, sessionID: string) {
  const state = ensureSessionState(tracker, sessionID)
  state.timer = undefined
  if (!(await isCompactorEnabled(tracker))) return
  state.isSettledThisIdlePeriod = true
  void compactSession(tracker, sessionID)
}

async function armIdleTimer(tracker: IdleTracker, sessionID: string) {
  const state = ensureSessionState(tracker, sessionID)
  if (state.timer || state.isSettledThisIdlePeriod) return
  if (!(await isCompactorEnabled(tracker))) return
  state.timer = setTimeout(
    () => void startCompaction(tracker, sessionID),
    tracker.idleTimeoutMs,
  )
}

function cancelIdleTimer(tracker: IdleTracker, sessionID: string) {
  const state = tracker.sessions.get(sessionID)
  if (!state) return
  if (state.timer) clearTimeout(state.timer)
  state.timer = undefined
}

function reopenIdlePeriod(tracker: IdleTracker, sessionID: string) {
  cancelIdleTimer(tracker, sessionID)
  ensureSessionState(tracker, sessionID).isSettledThisIdlePeriod = false
}

function forgetSession(tracker: IdleTracker, sessionID: string) {
  const state = tracker.sessions.get(sessionID)
  if (!state) return
  if (state.timer) clearTimeout(state.timer)
  tracker.sessions.delete(sessionID)
}

async function resolveIdleTimeoutMs(
  client: PluginInput["client"],
  options: Record<string, unknown>,
): Promise<number> {
  const configured = options.idleTimeoutMs
  if (configured === undefined) return DEFAULT_IDLE_TIMEOUT_MS
  if (isPositiveDurationMs(configured) && configured <= MAX_TIMER_DELAY_MS) {
    return configured
  }
  if (isPositiveDurationMs(configured)) {
    await writeLog(client, "warn", "IdleTimeoutMsClamped", {
      configured: String(configured),
      clampedMs: MAX_TIMER_DELAY_MS,
    })
    return MAX_TIMER_DELAY_MS
  }
  await writeLog(client, "warn", "InvalidIdleTimeoutMs", {
    configured: String(configured),
    fallbackMs: DEFAULT_IDLE_TIMEOUT_MS,
  })
  return DEFAULT_IDLE_TIMEOUT_MS
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
  }

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.status": {
          const { sessionID, status } = event.properties
          if (!sessionID || !status) return
          if (status.type === "idle") await armIdleTimer(tracker, sessionID)
          if (status.type === "busy") cancelIdleTimer(tracker, sessionID)
          return
        }
        case "session.deleted": {
          const sessionID = event.properties.info?.id
          if (sessionID) forgetSession(tracker, sessionID)
          return
        }
      }
    },
    "chat.message": async ({ sessionID }) => {
      if (sessionID) reopenIdlePeriod(tracker, sessionID)
    },
    dispose: async () => {
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
