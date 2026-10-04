import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { writeLog } from "../log.ts"
import { readOpenRouterApiKey } from "../openRouterAuth.ts"
import {
  isFeatureEnabled,
  logEssentialsConfigReadFailure,
  readEssentialsConfig,
  resolveEffectiveModel,
} from "../state.ts"
import type { FeatureId } from "../valueObject/featureId.ts"
import type { MessageId } from "../valueObject/messageId.ts"
import { newMessageId } from "../valueObject/messageId.ts"
import type { OpenRouterModelId } from "../valueObject/openRouterModelId.ts"
import type { PartId } from "../valueObject/partId.ts"
import { newPartId } from "../valueObject/partId.ts"
import type { SessionId } from "../valueObject/sessionId.ts"
import { newSessionId } from "../valueObject/sessionId.ts"
import { isRecord } from "../valueObject/util.ts"
import type { FeatureContext, ServerSuiteFeature } from "./feature.ts"
import { logRejectedHostId } from "./hostEventRejections.ts"
import { permissionAssistantFeature } from "./permission-assistant.ts"
import {
  DEFAULT_CLASSIFIER_MODEL,
  type DecisionVerdict,
  isReasoningLoopProbability,
  REASONING_LOOP_QUESTION,
  requestDecisionVerdict,
} from "./permissionDecision.ts"
import {
  auditReasoningLoopCheck,
  type ReasoningLoopVerdictOutcome,
} from "./reasoningLoopAudit.ts"
import { CLIENT_REQUEST_DEADLINE_MS } from "./requestDeadline.ts"

export const reasoningLoopGuardId: FeatureId =
  "reasoning-loop-guard" as FeatureId

const REPEATED_PHRASE_WORDS = 24
const PHRASE_REPEAT_MINIMUM = 3
const SCAN_TAIL_WORDS = 256
const MAX_TRACKED_PARTS = 32
const CHECK_STEP_WORDS = 128
const CLASSIFIER_GRACE_WORDS = 512
const MAX_CANCELLED_SPIRALS_PER_TURN = 3
const MAX_UNCLEARED_READINGS_PER_TURN = 3
const MAX_CLASSIFIER_SAMPLE_CHARS = 600
const REASONING_LOOP_CORRECTION =
  "The reasoning loop guard cancelled your response: you were repeating the same reasoning without progress. Do not resume those thoughts. Decide the next step in a few sentences and act, or report the blocker and what you tried."
const REASONING_LOOP_ESCALATION_CORRECTION =
  "The reasoning loop guard cancelled this response: your reasoning kept repeating and three loop checks did not clear it, so the guard stopped trusting its own read. Do not continue. Report the blocker and what you tried, and wait for the user's direction."

export function splitReasoningWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0)
}

// The suspect shape: the response's final 24-word phrase, written at least
// twice above its own last copy. Comparison runs on whole tokens, so a hit
// can never span word boundaries; adjacent repeats still count. The caller
// bounds `words` to the recent tail; a suspect is what pays the classifier
// call.
export function detectRepeatedPhrase(
  words: readonly string[],
): string | undefined {
  if (words.length < REPEATED_PHRASE_WORDS * PHRASE_REPEAT_MINIMUM) {
    return undefined
  }
  const phrase = words.slice(-REPEATED_PHRASE_WORDS)
  let repeats = 0
  for (let start = 0; start + phrase.length <= words.length; start += 1) {
    let matches = true
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (words[start + offset] !== phrase[offset]) {
        matches = false
        break
      }
    }
    if (!matches) continue
    repeats += 1
    start += phrase.length - 1
  }
  return repeats >= PHRASE_REPEAT_MINIMUM ? phrase.join(" ") : undefined
}

export type SpiralSuspect = {
  sessionId: SessionId
  messageId: MessageId
  phrase: string
}

type SuspectWatch = {
  activeMessageId: MessageId
  // Each stored part keeps only its last SCAN_TAIL_WORDS, so a long
  // response cannot grow this map past its bound. totalWords still counts
  // every observed word to pace the suspect checks.
  partTails: Map<PartId, string[]>
  partCounts: Map<PartId, number>
  // Deltas name no part type, so a part counts as reasoning only after a
  // full part update declared it; delta words land only for these ids.
  reasoningPartIds: Set<PartId>
  // The trailing fragment of a part's last delta, held back until the next
  // delta or the full-text update completes the word.
  partPending: Map<PartId, string>
  totalWords: number
  nextCheckAtWords: number
  isConsulting: boolean
}

export type SpiralSuspectWatcher = {
  observe(input: {
    sessionId: SessionId
    messageId: MessageId
    partId: PartId
    text: string
  }): void
  // Appends one streaming delta for a part a full update already declared
  // as reasoning. Word fragments at delta boundaries are held back, so the
  // phrase check only ever sees whole tokens.
  observeDelta(input: {
    sessionId: SessionId
    messageId: MessageId
    partId: PartId
    delta: string
  }): void
  // Clears the in-flight flag after a suspect verdict; `withGrace` delays
  // the next check past the plain step so a settled verdict is not
  // re-questioned word after word.
  settle(sessionId: SessionId, withGrace: boolean): void
  isMessageActive(sessionId: SessionId, messageId: MessageId): boolean
  // The message the session currently streams, if any. A stale verdict
  // reads this to tell a finished turn from a loop that moved to the next
  // response.
  activeMessageId(sessionId: SessionId): MessageId | undefined
  forgetMessage(sessionId: SessionId): void
}

function selectScanTail(
  partTails: ReadonlyMap<PartId, readonly string[]>,
): string[] {
  const all: string[] = []
  for (const tail of partTails.values()) all.push(...tail)
  return all.slice(-SCAN_TAIL_WORDS)
}

function newSuspectWatch(messageId: MessageId): SuspectWatch {
  return {
    activeMessageId: messageId,
    partTails: new Map(),
    partCounts: new Map(),
    reasoningPartIds: new Set(),
    partPending: new Map(),
    totalWords: 0,
    nextCheckAtWords: CHECK_STEP_WORDS,
    isConsulting: false,
  }
}

// Drops a part from every per-part map, so the three maps evict in
// lockstep and a delta can never resurrect an evicted part's count.
function dropPart(watch: SuspectWatch, partId: PartId): void {
  watch.partTails.delete(partId)
  watch.partCounts.delete(partId)
  watch.reasoningPartIds.delete(partId)
  watch.partPending.delete(partId)
}

function evictOverflowingParts(watch: SuspectWatch): void {
  if (watch.partTails.size <= MAX_TRACKED_PARTS) return
  const oldestPartId = watch.partTails.keys().next().value
  if (oldestPartId !== undefined) dropPart(watch, oldestPartId)
}

// One detection state machine, two consumers: the server guard asks Jev and
// interrupts, the TUI companion counts suspects to wake the human.
export function newSpiralSuspectWatcher(
  onSuspect: (suspect: SpiralSuspect) => void,
): SpiralSuspectWatcher {
  const sessions = new Map<SessionId, SuspectWatch>()

  // The paced suspect check: one scan per CHECK_STEP_WORDS of new text.
  // Both the full-text and the delta path end here.
  function runPacedCheck(
    input: {
      sessionId: SessionId
      messageId: MessageId
      partId: PartId
    },
    watch: SuspectWatch,
  ): void {
    if (watch.isConsulting || watch.totalWords < watch.nextCheckAtWords) return
    watch.nextCheckAtWords = watch.totalWords + CHECK_STEP_WORDS
    const phrase = detectRepeatedPhrase(selectScanTail(watch.partTails))
    if (phrase === undefined) return
    watch.isConsulting = true
    onSuspect({
      sessionId: input.sessionId,
      messageId: input.messageId,
      phrase,
    })
  }

  // A full part update replaces the part's words outright: the text is the
  // authoritative content, so count and tail reset to it.
  function replacePartWords(
    input: {
      sessionId: SessionId
      messageId: MessageId
      partId: PartId
    },
    watch: SuspectWatch,
    words: readonly string[],
  ): void {
    const previousCount = watch.partCounts.get(input.partId) ?? 0
    watch.partCounts.set(input.partId, words.length)
    watch.totalWords += words.length - previousCount
    watch.partTails.set(input.partId, words.slice(-SCAN_TAIL_WORDS))
    evictOverflowingParts(watch)
    runPacedCheck(input, watch)
  }

  function appendPartWords(
    input: {
      sessionId: SessionId
      messageId: MessageId
      partId: PartId
    },
    watch: SuspectWatch,
    words: readonly string[],
  ): void {
    const previousCount = watch.partCounts.get(input.partId) ?? 0
    watch.partCounts.set(input.partId, previousCount + words.length)
    watch.totalWords += words.length
    const tail = [...(watch.partTails.get(input.partId) ?? []), ...words]
    watch.partTails.set(input.partId, tail.slice(-SCAN_TAIL_WORDS))
    evictOverflowingParts(watch)
    runPacedCheck(input, watch)
  }

  function resolveSuspectWatch(input: {
    sessionId: SessionId
    messageId: MessageId
  }): SuspectWatch {
    const existing = sessions.get(input.sessionId)
    const watch =
      existing !== undefined && existing.activeMessageId === input.messageId
        ? existing
        : newSuspectWatch(input.messageId)
    sessions.set(input.sessionId, watch)
    return watch
  }

  function observe(input: {
    sessionId: SessionId
    messageId: MessageId
    partId: PartId
    text: string
  }): void {
    const watch = resolveSuspectWatch(input)
    watch.reasoningPartIds.add(input.partId)
    watch.partPending.delete(input.partId)
    replacePartWords(input, watch, splitReasoningWords(input.text))
  }

  function observeDelta(input: {
    sessionId: SessionId
    messageId: MessageId
    partId: PartId
    delta: string
  }): void {
    const watch = sessions.get(input.sessionId)
    if (
      watch === undefined ||
      watch.activeMessageId !== input.messageId ||
      !watch.reasoningPartIds.has(input.partId)
    ) {
      return
    }
    const pending = watch.partPending.get(input.partId) ?? ""
    const buffer = pending + input.delta
    const pieces = buffer.split(/\s+/)
    const endsInsideWord = buffer.length > 0 && !/\s$/.test(buffer)
    const heldBack = endsInsideWord ? (pieces.pop() ?? "") : ""
    const complete = pieces.filter((piece) => piece.length > 0)
    watch.partPending.delete(input.partId)
    if (heldBack.length > 0) watch.partPending.set(input.partId, heldBack)
    if (complete.length === 0) return
    appendPartWords(input, watch, complete)
  }

  function settle(sessionId: SessionId, withGrace: boolean): void {
    const watch = sessions.get(sessionId)
    if (!watch) return
    watch.isConsulting = false
    if (withGrace) {
      watch.nextCheckAtWords = watch.totalWords + CLASSIFIER_GRACE_WORDS
    }
  }

  function isMessageActive(sessionId: SessionId, messageId: MessageId) {
    return sessions.get(sessionId)?.activeMessageId === messageId
  }

  function activeMessageId(sessionId: SessionId): MessageId | undefined {
    return sessions.get(sessionId)?.activeMessageId
  }

  function forgetMessage(sessionId: SessionId): void {
    sessions.delete(sessionId)
  }

  return {
    observe,
    observeDelta,
    settle,
    isMessageActive,
    activeMessageId,
    forgetMessage,
  }
}

type SessionPolicy = {
  interruptCount: number
  // Suspect readings that came back without a clearing verdict: an
  // abstention, a failed call, or a missing credential.
  unclearedReadings: number
  isEscalated: boolean
  // The guard's correction arrives as a real chat.message, which would
  // otherwise clear the per-turn counters on the very turn it is meant to
  // police. Delivery arms this flag; the next chat.message spends it and
  // keeps the counters instead of resetting.
  isCorrectionPending: boolean
  // Bumped on every chat.message, so a verdict can tell the turn it judged
  // from whatever turn is running by the time the verdict arrives.
  turnGeneration: number
}

type LoopGuardTracker = {
  client: PluginInput["client"]
  isDisposed: boolean
  watcher: SpiralSuspectWatcher
  policies: Map<SessionId, SessionPolicy>
  credentialFailureWasLogged: boolean
  eventRejectionWasLogged: boolean
}

function ensureSessionPolicy(
  tracker: LoopGuardTracker,
  sessionId: SessionId,
): SessionPolicy {
  const existing = tracker.policies.get(sessionId)
  if (existing) return existing
  const fresh: SessionPolicy = {
    interruptCount: 0,
    unclearedReadings: 0,
    isEscalated: false,
    isCorrectionPending: false,
    turnGeneration: 0,
  }
  tracker.policies.set(sessionId, fresh)
  return fresh
}

// Returns whether the run was cancelled; the budget only spends real
// cancellations, and the delivery failure is logged where it happens.
async function abortRunWithCorrection(
  tracker: LoopGuardTracker,
  policy: SessionPolicy,
  sessionId: SessionId,
  correction: string,
): Promise<boolean> {
  try {
    const aborted = await tracker.client.session.abort({
      path: { id: sessionId },
      signal: AbortSignal.timeout(CLIENT_REQUEST_DEADLINE_MS),
    })
    if (aborted.error) {
      await writeLog(tracker.client, "warn", "ReasoningLoopAbortFailed", {
        sessionId,
        error: JSON.stringify(aborted.error),
      })
      return false
    }
    policy.isCorrectionPending = true
    const prompted = await tracker.client.session.promptAsync({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text: correction }] },
      signal: AbortSignal.timeout(CLIENT_REQUEST_DEADLINE_MS),
    })
    if (prompted.error) {
      policy.isCorrectionPending = false
      await writeLog(
        tracker.client,
        "warn",
        "ReasoningLoopCorrectionDeliveryFailed",
        { sessionId, error: JSON.stringify(prompted.error) },
      )
    }
    return true
  } catch (failure) {
    policy.isCorrectionPending = false
    await writeLog(tracker.client, "warn", "ReasoningLoopInterruptFailed", {
      sessionId,
      error: String(failure),
    })
    return false
  }
}

// Every Jev spiral check leaves one line in the doom log, whatever the
// guard does with the verdict next. A failed audit write counts as loud:
// the audit is the only place the spiraling question is answered later.
async function recordSpiralCheck(
  tracker: LoopGuardTracker,
  check: {
    sessionId: SessionId
    model: OpenRouterModelId
    phrase: string
    outcome: ReasoningLoopVerdictOutcome
    probability: number | undefined
  },
): Promise<void> {
  const auditFailure = auditReasoningLoopCheck(check)
  if (auditFailure) {
    await writeLog(tracker.client, "warn", "ReasoningLoopAuditWriteFailed", {
      sessionId: check.sessionId,
      error: String(auditFailure),
    })
  }
}

// Cancels the run for a confirmed spiral and delivers the correction. The
// budget bounds the interrupts per turn; a refused cancel stops the guard
// for the turn.
async function interruptConfirmedSpiral(
  tracker: LoopGuardTracker,
  sessionId: SessionId,
  probability: number,
): Promise<void> {
  const policy = ensureSessionPolicy(tracker, sessionId)
  if (policy.interruptCount >= MAX_CANCELLED_SPIRALS_PER_TURN) {
    tracker.watcher.forgetMessage(sessionId)
    policy.isEscalated = true
    await writeLog(tracker.client, "warn", "ReasoningLoopGuardGaveUp", {
      sessionId,
      interruptCount: String(policy.interruptCount),
    })
    return
  }
  tracker.watcher.forgetMessage(sessionId)
  const wasCancelled = await abortRunWithCorrection(
    tracker,
    policy,
    sessionId,
    REASONING_LOOP_CORRECTION,
  )
  if (!wasCancelled) {
    policy.isEscalated = true
    return
  }
  policy.interruptCount += 1
  await writeLog(tracker.client, "warn", "ReasoningLoopInterrupted", {
    sessionId,
    probability: String(probability),
    interruptCount: String(policy.interruptCount),
  })
}

async function judgeSuspectedSpiral(
  tracker: LoopGuardTracker,
  suspect: SpiralSuspect,
  suspectTurnGeneration: number,
): Promise<void> {
  const { sessionId, messageId, phrase } = suspect
  const configRead = readEssentialsConfig()
  if (configRead.error) {
    tracker.watcher.settle(sessionId, false)
    await logEssentialsConfigReadFailure(tracker.client, configRead.error)
    return
  }
  if (!isFeatureEnabled(configRead.config, reasoningLoopGuardId)) {
    tracker.watcher.settle(sessionId, false)
    return
  }
  const model = resolveEffectiveModel(
    configRead.config,
    permissionAssistantFeature.id,
    DEFAULT_CLASSIFIER_MODEL,
  )
  const credential = readOpenRouterApiKey(process.env.OPENROUTER_API_KEY)
  if (!credential.apiKey) {
    tracker.watcher.settle(sessionId, false)
    ensureSessionPolicy(tracker, sessionId).unclearedReadings += 1
    if (!tracker.credentialFailureWasLogged) {
      tracker.credentialFailureWasLogged = true
      await writeLog(tracker.client, "warn", "ReasoningLoopCredentialMissing", {
        detail: credential.error ?? "Run opencode auth login",
      })
    }
    return
  }
  let verdict: DecisionVerdict
  try {
    verdict = await requestDecisionVerdict({
      apiKey: credential.apiKey,
      model,
      question: REASONING_LOOP_QUESTION,
      patterns: [phrase.slice(0, MAX_CLASSIFIER_SAMPLE_CHARS)],
      signal: AbortSignal.timeout(CLIENT_REQUEST_DEADLINE_MS),
    })
  } catch (failure) {
    settleIfActive(tracker, sessionId, messageId, true)
    ensureSessionPolicy(tracker, sessionId).unclearedReadings += 1
    await recordSpiralCheck(tracker, {
      sessionId,
      model,
      phrase,
      outcome: "failed",
      probability: undefined,
    })
    await writeLog(
      tracker.client,
      "warn",
      "ReasoningLoopClassificationFailed",
      {
        sessionId,
        error: String(failure),
      },
    )
    return
  }
  if (tracker.isDisposed) return
  const probabilityConfirms = isReasoningLoopProbability(verdict.probability)
  if (!tracker.watcher.isMessageActive(sessionId, messageId)) {
    await recordSpiralCheck(tracker, {
      sessionId,
      model,
      phrase,
      outcome: "stale",
      probability: verdict.probability,
    })
    if (!probabilityConfirms) {
      await writeLog(tracker.client, "debug", "ReasoningLoopVerdictStale", {
        sessionId,
      })
      return
    }
    // The verdict confirmed a loop whose response has ended. The interrupt
    // is only allowed to land on the turn the suspect came from: a matching
    // turn generation and a live response mean the spiral continues in the
    // next response of the same turn. Anything else — the turn finished, or
    // a newer turn is running — gets a loud log line and no cancel.
    const currentGeneration = tracker.policies.get(sessionId)?.turnGeneration
    const isSameTurn =
      currentGeneration !== undefined &&
      suspectTurnGeneration === currentGeneration
    if (
      isSameTurn &&
      tracker.watcher.activeMessageId(sessionId) !== undefined
    ) {
      await interruptConfirmedSpiral(tracker, sessionId, verdict.probability)
      return
    }
    await writeLog(
      tracker.client,
      "warn",
      "ReasoningLoopVerdictLateConfirmed",
      {
        sessionId,
        probability: String(verdict.probability),
      },
    )
    return
  }
  if (!probabilityConfirms) {
    await recordSpiralCheck(tracker, {
      sessionId,
      model,
      phrase,
      outcome: "cleared",
      probability: verdict.probability,
    })
    tracker.watcher.settle(sessionId, true)
    const policy = ensureSessionPolicy(tracker, sessionId)
    policy.unclearedReadings += 1
    await writeLog(tracker.client, "debug", "ReasoningLoopVerdictCleared", {
      sessionId,
      probability: String(verdict.probability),
      unclearedReadings: String(policy.unclearedReadings),
    })
    return
  }
  await recordSpiralCheck(tracker, {
    sessionId,
    model,
    phrase,
    outcome: "confirmed",
    probability: verdict.probability,
  })
  await interruptConfirmedSpiral(tracker, sessionId, verdict.probability)
}

// Three readings came back without clearing the same loop — Jev abstained,
// the call failed, or no credential exists — and a fourth suspect arrives.
// Repetition this persistent is a runaway whatever the classifier says. The
// guard stops chasing verdicts and interrupts the way the doom-loop guard
// does: cancel, and a correction that hands the decision to the human. The
// TUI companion wakes the human on the same fourth suspect.
async function escalateUncertainLoop(
  tracker: LoopGuardTracker,
  sessionId: SessionId,
): Promise<void> {
  const policy = ensureSessionPolicy(tracker, sessionId)
  policy.isEscalated = true
  tracker.watcher.forgetMessage(sessionId)
  await writeLog(tracker.client, "warn", "ReasoningLoopUnclearedCap", {
    sessionId,
    unclearedReadings: String(policy.unclearedReadings),
  })
  await abortRunWithCorrection(
    tracker,
    policy,
    sessionId,
    REASONING_LOOP_ESCALATION_CORRECTION,
  )
}

// A settle that lands after the consulted message was replaced would clear
// the in-flight flag of a suspect the next round is already judging; only
// the message that raised the suspect may put its own watch back in pace.
function settleIfActive(
  tracker: LoopGuardTracker,
  sessionId: SessionId,
  messageId: MessageId,
  withGrace: boolean,
): void {
  if (!tracker.watcher.isMessageActive(sessionId, messageId)) return
  tracker.watcher.settle(sessionId, withGrace)
}

function onSuspect(tracker: LoopGuardTracker, suspect: SpiralSuspect): void {
  const policy = ensureSessionPolicy(tracker, suspect.sessionId)
  if (policy.isEscalated) {
    tracker.watcher.forgetMessage(suspect.sessionId)
    return
  }
  if (policy.unclearedReadings >= MAX_UNCLEARED_READINGS_PER_TURN) {
    void escalateUncertainLoop(tracker, suspect.sessionId).catch(
      (failure: unknown) => {
        void writeLog(tracker.client, "warn", "ReasoningLoopGuardFailed", {
          sessionId: suspect.sessionId,
          error: String(failure),
        })
      },
    )
    return
  }
  void judgeSuspectedSpiral(
    tracker,
    suspect,
    ensureSessionPolicy(tracker, suspect.sessionId).turnGeneration,
  ).catch((failure: unknown) => {
    settleIfActive(tracker, suspect.sessionId, suspect.messageId, true)
    void writeLog(tracker.client, "warn", "ReasoningLoopGuardFailed", {
      sessionId: suspect.sessionId,
      error: String(failure),
    })
  })
}

// Part events stream per token chunk, so a malformed id would repeat its
// warn line thousands of times per minute. The protocol drift is one fact:
// the first rejection is logged, the rest are silence the operator already
// has evidence for.
async function logRejectedPartEvent(
  tracker: LoopGuardTracker,
  reason: string,
  rejectedValue: unknown,
) {
  if (tracker.eventRejectionWasLogged) return
  tracker.eventRejectionWasLogged = true
  await logRejectedHostId(
    tracker.client,
    "LoopEventRejected",
    reason,
    rejectedValue,
  )
}

function forgetActiveMessage(tracker: LoopGuardTracker, sessionId: SessionId) {
  tracker.watcher.forgetMessage(sessionId)
}

// Feeds one reasoning delta to the watcher. The delta event names no part
// type, so only parts a full update already declared as reasoning accept
// deltas; everything else (text parts, unknown parts) is silence.
async function observeReasoningDelta(
  tracker: LoopGuardTracker,
  properties: unknown,
): Promise<void> {
  if (!isRecord(properties) || properties.field !== "text") return
  const sessionId = newSessionId(properties.sessionID)
  const messageId = newMessageId(properties.messageID)
  const partId = newPartId(properties.partID)
  if (!sessionId) {
    await logRejectedPartEvent(
      tracker,
      "message.part.delta",
      properties.sessionID,
    )
    return
  }
  if (
    !messageId ||
    !partId ||
    typeof properties.delta !== "string" ||
    properties.delta.length === 0
  ) {
    await logRejectedPartEvent(
      tracker,
      "message.part.delta",
      `${String(properties.messageID)}/${String(properties.partID)}`,
    )
    return
  }
  tracker.watcher.observeDelta({
    sessionId,
    messageId,
    partId,
    delta: properties.delta,
  })
}

function startFreshTurn(tracker: LoopGuardTracker, sessionId: SessionId) {
  const policy = ensureSessionPolicy(tracker, sessionId)
  policy.turnGeneration += 1
  if (policy.isCorrectionPending) {
    policy.isCorrectionPending = false
    return
  }
  tracker.watcher.forgetMessage(sessionId)
  policy.interruptCount = 0
  policy.unclearedReadings = 0
  policy.isEscalated = false
}

async function buildHooks(context: FeatureContext): Promise<Hooks> {
  const tracker: LoopGuardTracker = {
    client: context.client,
    isDisposed: false,
    watcher: newSpiralSuspectWatcher((suspect) => onSuspect(tracker, suspect)),
    policies: new Map(),
    credentialFailureWasLogged: false,
    eventRejectionWasLogged: false,
  }

  return {
    event: async ({ event }) => {
      // Streaming reasoning travels as part deltas, not as part updates. A
      // reasoning part's `updated` event fires only at its start (empty
      // text) and its end (full text). The delta event is missing from the
      // SDK's event union, so the code matches the type as a string and
      // checks the shape structurally.
      if ((event.type as string) === "message.part.delta") {
        await observeReasoningDelta(tracker, event.properties)
        return
      }
      switch (event.type) {
        case "message.part.updated": {
          const part = event.properties?.part
          if (!isRecord(part) || part.type !== "reasoning") return
          const sessionId = newSessionId(part.sessionID)
          const messageId = newMessageId(part.messageID)
          const partId = newPartId(part.id)
          if (!sessionId) {
            await logRejectedPartEvent(tracker, event.type, part.sessionID)
            return
          }
          if (!messageId || !partId || typeof part.text !== "string") {
            await logRejectedPartEvent(
              tracker,
              event.type,
              `${String(part.messageID)}/${String(part.id)}`,
            )
            return
          }
          tracker.watcher.observe({
            sessionId,
            messageId,
            partId,
            text: part.text,
          })
          return
        }
        case "session.status": {
          const sessionId = newSessionId(event.properties?.sessionID)
          if (!sessionId) return
          if (event.properties?.status?.type === "idle") {
            forgetActiveMessage(tracker, sessionId)
          }
          return
        }
        case "session.error": {
          const sessionId = newSessionId(event.properties?.sessionID)
          if (sessionId) forgetActiveMessage(tracker, sessionId)
          return
        }
        case "session.deleted": {
          const sessionId = newSessionId(event.properties?.info?.id)
          if (!sessionId) return
          tracker.watcher.forgetMessage(sessionId)
          tracker.policies.delete(sessionId)
          return
        }
      }
    },
    "chat.message": async ({ sessionID: rawSessionId }) => {
      const sessionId = newSessionId(rawSessionId)
      if (!sessionId) {
        await logRejectedHostId(
          tracker.client,
          "LoopEventSessionIdRejected",
          "chat.message",
          rawSessionId,
        )
        return
      }
      startFreshTurn(tracker, sessionId)
    },
    dispose: async () => {
      tracker.isDisposed = true
      tracker.policies.clear()
    },
  }
}

export const reasoningLoopGuardFeature: ServerSuiteFeature = {
  id: reasoningLoopGuardId,
  title: "Reasoning Loop Guard",
  description:
    "Cancels a response whose reasoning repeats itself after Jev confirms the spiral, hands a loop Jev will not clear to the human, and tells the model to change approach.",
  buildHooks,
}
