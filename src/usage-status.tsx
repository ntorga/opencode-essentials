/** @jsxImportSource @opentui/solid */

import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { createMemo, Show } from "solid-js"
import { usageStatusFeature } from "./features/usage-status.ts"
import { sanitizeText } from "./log.ts"
import { isFeatureEnabled, readEssentialsConfig } from "./state.ts"
import {
  formatResponseUsageStatus,
  resolveResponseUsageStatus,
} from "./usageStatus.ts"
import { newSessionId } from "./valueObject/sessionId.ts"

function resolveResponseUsageLine(
  api: TuiPluginApi,
  config: ReturnType<typeof readEssentialsConfig>["config"],
): string | undefined {
  if (!isFeatureEnabled(config, usageStatusFeature.id)) {
    return undefined
  }

  const route = api.route.current
  if (route.name !== "session") return undefined
  const sessionId = newSessionId(route.params?.sessionID)
  if (!sessionId) return undefined

  const usage = resolveResponseUsageStatus(
    api.state.session.messages(sessionId),
    (messageId) => api.state.part(messageId),
  )
  if (!usage) return undefined
  return formatResponseUsageStatus(usage)
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

function ResponseUsageView(props: { api: TuiPluginApi }) {
  let configFailureWasReported = false
  const line = createMemo(() => {
    const configRead = readEssentialsConfig()
    if (configRead.error) {
      if (!configFailureWasReported) {
        configFailureWasReported = true
        reportConfigReadFailure(props.api, configRead.error)
      }
      return undefined
    }
    configFailureWasReported = false
    return resolveResponseUsageLine(props.api, configRead.config)
  })
  return (
    <Show when={line()}>
      {(currentLine: () => string) => (
        <box
          flexDirection="row"
          width="100%"
          paddingLeft={2}
          backgroundColor={props.api.theme.current.backgroundPanel}
        >
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {currentLine()}
          </text>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 90,
    slots: {
      app_bottom() {
        return <ResponseUsageView api={api} />
      },
    },
  })
}

export default {
  id: "opencode-essentials-usage-status",
  tui,
} satisfies TuiPluginModule
