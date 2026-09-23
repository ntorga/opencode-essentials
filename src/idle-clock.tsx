/** @jsxImportSource @opentui/solid */

import type { PluginOptions } from "@opencode-ai/plugin"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { idleClockFeature } from "./features/idle-clock.ts"
import {
  type IdleClockColor,
  type IdleClockLine,
  resolveIdleClockLine,
  toIdleClockMessages,
} from "./idleWaiting.ts"
import {
  isFeatureEnabled,
  readEssentialsConfig,
  resolveEffectiveIdleTimeoutMs,
} from "./state.ts"
import type { FeatureId } from "./valueObject/featureId.ts"
import type { IdleTimeoutMs } from "./valueObject/idleTimeoutMs.ts"
import {
  clampIdleTimeoutToTimerDelay,
  DEFAULT_IDLE_TIMEOUT_MS,
  newIdleTimeoutMs,
} from "./valueObject/idleTimeoutMs.ts"
import { newSessionId } from "./valueObject/sessionId.ts"
import { isRecord } from "./valueObject/util.ts"

const CLOCK_TICK_MS = 1_000
const idleAutoCompactorId = "idle-auto-compactor" as FeatureId

function resolveIdleCompactorTimeout(
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

function resolveIdleClockTextColor(api: TuiPluginApi, color: IdleClockColor) {
  if (color === "error") return api.theme.current.error
  if (color === "warning") return api.theme.current.warning
  return api.theme.current.textMuted
}

function IdleClockView(props: {
  api: TuiPluginApi
  defaultIdleTimeoutMs: IdleTimeoutMs
}) {
  const [nowMs, setNowMs] = createSignal(Date.now())
  const ticker = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS)
  onCleanup(() => clearInterval(ticker))
  const line = createMemo(() => {
    const tickMs = nowMs()
    const configRead = readEssentialsConfig()
    if (configRead.error) return undefined
    if (!isFeatureEnabled(configRead.config, idleClockFeature.id)) {
      return undefined
    }
    const route = props.api.route.current
    if (route.name !== "session") return undefined
    const sessionId = newSessionId(route.params?.sessionID)
    if (!sessionId) return undefined
    const status = props.api.state.session.status(sessionId)
    const messages = toIdleClockMessages(
      props.api.state.session.messages(sessionId),
    )
    return resolveIdleClockLine(status?.type, messages, tickMs, {
      enabled: isFeatureEnabled(configRead.config, idleAutoCompactorId),
      idleTimeoutMs: clampIdleTimeoutToTimerDelay(
        resolveEffectiveIdleTimeoutMs(
          configRead.config,
          idleAutoCompactorId,
          props.defaultIdleTimeoutMs,
        ),
      ),
    })
  })
  return (
    <Show when={line()}>
      {(currentLine: () => IdleClockLine) => (
        <box flexDirection="row" paddingLeft={2}>
          <text fg={resolveIdleClockTextColor(props.api, currentLine().color)}>
            {currentLine().text}
          </text>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const defaultIdleTimeoutMs = resolveIdleCompactorTimeout(options)
  api.slots.register({
    order: 100,
    slots: {
      app_bottom() {
        return (
          <IdleClockView
            api={api}
            defaultIdleTimeoutMs={defaultIdleTimeoutMs}
          />
        )
      },
    },
  })
}

export default {
  id: "opencode-essentials-idle-clock",
  tui,
} satisfies TuiPluginModule
