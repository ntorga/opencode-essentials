import type { PluginOptions } from "@opencode-ai/plugin"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { idleClockFeature } from "./features/idle-clock.ts"
import {
  type IdleClockColor,
  type IdleClockLine,
  resolveIdleClockLine,
  toIdleClockMessages,
} from "./idleWaiting.ts"
import { isFeatureEnabled, resolveEffectiveIdleTimeoutMs } from "./state.ts"
import type { EssentialsConfig } from "./valueObject/essentialsConfig.ts"
import type { FeatureId } from "./valueObject/featureId.ts"
import type { IdleTimeoutMs } from "./valueObject/idleTimeoutMs.ts"
import {
  clampIdleTimeoutToTimerDelay,
  DEFAULT_IDLE_TIMEOUT_MS,
  newIdleTimeoutMs,
} from "./valueObject/idleTimeoutMs.ts"
import type { SessionId } from "./valueObject/sessionId.ts"
import { isRecord } from "./valueObject/util.ts"

const idleAutoCompactorId = "idle-auto-compactor" as FeatureId

export function resolveIdleCompactorTimeout(
  options: PluginOptions | undefined,
): IdleTimeoutMs {
  if (!isRecord(options) || !isRecord(options.features)) {
    return DEFAULT_IDLE_TIMEOUT_MS
  }
  const featureOptions = options.features["idle-auto-compactor"]
  if (!isRecord(featureOptions)) return DEFAULT_IDLE_TIMEOUT_MS
  return (
    newIdleTimeoutMs(featureOptions.idleTimeoutMs) ?? DEFAULT_IDLE_TIMEOUT_MS
  )
}

export function resolveIdleClockTextColor(
  api: TuiPluginApi,
  color: IdleClockColor,
) {
  if (color === "error") return api.theme.current.error
  if (color === "warning") return api.theme.current.warning
  return api.theme.current.textMuted
}

export function resolveIdleClockLineForSession(
  api: TuiPluginApi,
  config: EssentialsConfig,
  sessionId: SessionId,
  nowMs: number,
  defaultIdleTimeoutMs: IdleTimeoutMs,
): IdleClockLine | undefined {
  if (!isFeatureEnabled(config, idleClockFeature.id)) return undefined
  const status = api.state.session.status(sessionId)
  const messages = toIdleClockMessages(api.state.session.messages(sessionId))
  return resolveIdleClockLine(status?.type, messages, nowMs, {
    enabled: isFeatureEnabled(config, idleAutoCompactorId),
    idleTimeoutMs: clampIdleTimeoutToTimerDelay(
      resolveEffectiveIdleTimeoutMs(
        config,
        idleAutoCompactorId,
        defaultIdleTimeoutMs,
      ),
    ),
  })
}
