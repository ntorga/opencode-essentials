/** @jsxImportSource @opentui/solid */

import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { EssentialsConfig } from "./documents/essentialsDocument.ts"
import { usageStatusFeature } from "./features/usage-status.ts"
import { sanitizeText } from "./log.ts"
import { isFeatureEnabled, readEssentialsConfig } from "./state.ts"
import {
  resolveIdleClockLineForSession,
  resolveIdleCompactorTimeout,
} from "./statusBar/idleClockStatus.ts"
import type { IdleClockLine } from "./statusBar/idleWaiting.ts"
import { resolveStatusBarTextColor } from "./statusBar/tone.ts"
import type { ResponseUsageSegment } from "./statusBar/usageStatus.ts"
import {
  formatResponseUsageStatus,
  resolveResponseUsageStatus,
} from "./statusBar/usageStatus.ts"
import type { IdleTimeoutMs } from "./valueObject/idleTimeoutMs.ts"
import type { SessionId } from "./valueObject/sessionId.ts"
import { newSessionId } from "./valueObject/sessionId.ts"

const CLOCK_TICK_MS = 1_000

type StatusBarLines = {
  idleClock: IdleClockLine | undefined
  responseUsage: ResponseUsageSegment[] | undefined
}

function resolveSessionId(api: TuiPluginApi): SessionId | undefined {
  const route = api.route.current
  if (route.name !== "session") return undefined
  return newSessionId(route.params?.sessionID)
}

function resolveResponseUsageLine(
  api: TuiPluginApi,
  config: EssentialsConfig,
  sessionId: SessionId,
): ResponseUsageSegment[] | undefined {
  if (!isFeatureEnabled(config, usageStatusFeature.id)) {
    return undefined
  }

  const usage = resolveResponseUsageStatus(
    api.state.session.messages(sessionId),
    (messageId) => api.state.part(messageId),
  )
  if (!usage) return undefined
  return formatResponseUsageStatus(usage)
}

function resolveStatusBarLines(
  api: TuiPluginApi,
  config: EssentialsConfig,
  sessionId: SessionId,
  nowMs: number,
  defaultIdleTimeoutMs: IdleTimeoutMs,
): StatusBarLines | undefined {
  const idleClock = resolveIdleClockLineForSession(
    api,
    config,
    sessionId,
    nowMs,
    defaultIdleTimeoutMs,
  )
  const responseUsage = resolveResponseUsageLine(api, config, sessionId)
  if (!idleClock && !responseUsage) return undefined
  return { idleClock, responseUsage }
}

function reportConfigReadFailure(api: TuiPluginApi, failure: unknown): void {
  const message = sanitizeText(`EssentialsConfigReadFailed: ${String(failure)}`)
  void api.client.app
    .log({
      service: "opencode-essentials",
      level: "warn",
      message: "EssentialsConfigReadFailed",
      extra: { error: sanitizeText(failure) },
    })
    .then((result) => {
      if (!("error" in result) || !result.error) return
      api.ui.toast({ variant: "warning", message })
    })
    .catch(() => {
      api.ui.toast({ variant: "warning", message })
    })
}

function StatusBarView(props: {
  api: TuiPluginApi
  defaultIdleTimeoutMs: IdleTimeoutMs
}) {
  const [nowMs, setNowMs] = createSignal(Date.now())
  const ticker = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS)
  onCleanup(() => clearInterval(ticker))
  let configFailureWasReported = false
  const lines = createMemo(() => {
    const tickMs = nowMs()
    const configRead = readEssentialsConfig()
    if (configRead.error) {
      if (!configFailureWasReported) {
        configFailureWasReported = true
        reportConfigReadFailure(props.api, configRead.error)
      }
      return undefined
    }
    configFailureWasReported = false
    const sessionId = resolveSessionId(props.api)
    if (!sessionId) return undefined
    return resolveStatusBarLines(
      props.api,
      configRead.config,
      sessionId,
      tickMs,
      props.defaultIdleTimeoutMs,
    )
  })
  return (
    <Show when={lines()}>
      {(currentLines: () => StatusBarLines) => (
        <box
          flexDirection="row"
          width="100%"
          paddingLeft={2}
          paddingTop={1}
          paddingBottom={1}
          gap={1}
          backgroundColor={props.api.theme.current.backgroundPanel}
        >
          <Show when={currentLines().idleClock}>
            {(idleClock: () => IdleClockLine) => (
              <text
                fg={resolveStatusBarTextColor(props.api, idleClock().color)}
                wrapMode="none"
              >
                {idleClock().text}
              </text>
            )}
          </Show>
          <Show when={currentLines().idleClock && currentLines().responseUsage}>
            <text fg={props.api.theme.current.textMuted} wrapMode="none">
              ·
            </text>
          </Show>
          <Show when={currentLines().responseUsage}>
            {(segments: () => ResponseUsageSegment[]) => (
              <text fg={props.api.theme.current.textMuted} wrapMode="none">
                <For each={segments()}>
                  {(segment: ResponseUsageSegment, index: () => number) => (
                    <>
                      {index() > 0 ? " · " : ""}
                      {segment.prefix ?? ""}
                      <span
                        style={{
                          fg: resolveStatusBarTextColor(
                            props.api,
                            segment.tone,
                          ),
                        }}
                      >
                        {segment.value}
                      </span>
                      {segment.suffix ?? ""}
                    </>
                  )}
                </For>
              </text>
            )}
          </Show>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const defaultIdleTimeoutMs = resolveIdleCompactorTimeout(options)
  api.slots.register({
    order: 90,
    slots: {
      app_bottom() {
        return (
          <StatusBarView
            api={api}
            defaultIdleTimeoutMs={defaultIdleTimeoutMs}
          />
        )
      },
    },
  })
}

export default {
  id: "opencode-essentials-status-bar",
  tui,
} satisfies TuiPluginModule
