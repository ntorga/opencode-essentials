import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import {
  newSpiralSuspectWatcher,
  reasoningLoopGuardId,
  type SpiralSuspect,
} from "./features/reasoning-loop-guard.ts"
import { sanitizeText } from "./log.ts"
import { isFeatureEnabled, readEssentialsConfig } from "./state.ts"
import type { MessageId } from "./valueObject/messageId.ts"
import { newMessageId } from "./valueObject/messageId.ts"
import { newPartId } from "./valueObject/partId.ts"
import type { SessionId } from "./valueObject/sessionId.ts"
import { newSessionId } from "./valueObject/sessionId.ts"
import { isRecord } from "./valueObject/util.ts"

const ESCALATE_AFTER_SUSPECTS = 4
const ESCALATION_TITLE = "OpenCode looks stuck"
const ESCALATION_MESSAGE =
  "The model's reasoning looped four times in one response and repeated checks did not clear it. The guard stops the run — read the transcript and steer."

type SessionEscalation = {
  messageId: MessageId | undefined
  suspectCount: number
  hasNotified: boolean
}

function showHumanEscalation(api: TuiPluginApi): void {
  if (
    !api.tuiConfig.attention.enabled ||
    !api.tuiConfig.attention.notifications
  ) {
    api.ui.toast({ variant: "warning", message: ESCALATION_MESSAGE })
    return
  }
  void api.attention
    .notify({
      title: ESCALATION_TITLE,
      message: ESCALATION_MESSAGE,
      notification: { when: "always" },
      sound: { name: "permission", when: "always" },
    })
    .then((result) => {
      if (result.ok) return
      api.ui.toast({ variant: "warning", message: ESCALATION_MESSAGE })
    })
    .catch(() => {
      api.ui.toast({ variant: "warning", message: ESCALATION_MESSAGE })
    })
}

function logConfigReadFailure(api: TuiPluginApi, failure: unknown): void {
  void api.client.app
    .log({
      service: "opencode-essentials",
      level: "warn",
      message: "EssentialsConfigReadFailed",
      extra: { error: sanitizeText(failure) },
    })
    .catch(() => {})
}

const tui: TuiPlugin = async (api) => {
  const escalations = new Map<SessionId, SessionEscalation>()
  const watcher = newSpiralSuspectWatcher((suspect: SpiralSuspect) => {
    const configRead = readEssentialsConfig()
    if (configRead.error) {
      watcher.settle(suspect.sessionId, false)
      logConfigReadFailure(api, configRead.error)
      return
    }
    if (!isFeatureEnabled(configRead.config, reasoningLoopGuardId)) {
      watcher.settle(suspect.sessionId, false)
      return
    }
    const existing = escalations.get(suspect.sessionId)
    const state =
      existing !== undefined && existing.messageId === suspect.messageId
        ? existing
        : { messageId: suspect.messageId, suspectCount: 0, hasNotified: false }
    escalations.set(suspect.sessionId, state)
    state.suspectCount += 1
    watcher.settle(suspect.sessionId, true)
    if (state.suspectCount < ESCALATE_AFTER_SUSPECTS || state.hasNotified) {
      return
    }
    state.hasNotified = true
    showHumanEscalation(api)
    void api.client.app
      .log({
        service: "opencode-essentials",
        level: "warn",
        message: "ReasoningLoopHumanEscalation",
        extra: {
          sessionId: suspect.sessionId,
          suspectCount: String(state.suspectCount),
        },
      })
      .catch(() => {})
  })

  const stopPart = api.event.on("message.part.updated", (event) => {
    const part = event.properties.part
    if (!isRecord(part) || part.type !== "reasoning") return
    const sessionId = newSessionId(part.sessionID)
    const messageId = newMessageId(part.messageID)
    const partId = newPartId(part.id)
    if (!sessionId || !messageId || !partId || typeof part.text !== "string") {
      return
    }
    watcher.observe({ sessionId, messageId, partId, text: part.text })
  })

  const stopIdle = api.event.on("session.idle", (event) => {
    const sessionId = newSessionId(event.properties.sessionID)
    if (sessionId) escalations.delete(sessionId)
  })

  api.lifecycle.onDispose(() => {
    stopPart()
    stopIdle()
    escalations.clear()
  })
}

export default {
  id: "opencode-essentials-reasoning-escalation",
  tui,
} satisfies TuiPluginModule
