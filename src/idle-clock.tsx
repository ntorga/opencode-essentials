/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { idleClockFeature } from "./features/idle-clock.ts"
import { isFeatureEnabled, readEssentialsConfig } from "./state.ts"
import { resolveIdleClockLine, toIdleClockMessages } from "./idleWaiting.ts"
import { newSessionId } from "./valueObject/sessionId.ts"

const CLOCK_TICK_MS = 1_000

function IdleClockView(props: { api: TuiPluginApi }) {
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
    const sessionId = newSessionId(route.params?.["sessionID"])
    if (!sessionId) return undefined
    const status = props.api.state.session.status(sessionId)
    const messages = toIdleClockMessages(
      props.api.state.session.messages(sessionId),
    )
    return resolveIdleClockLine(status?.type, messages, tickMs)
  })
  return (
    <Show when={line() !== undefined}>
      <box flexDirection="row" paddingLeft={2}>
        <text fg={props.api.theme.current.textMuted}>{line()}</text>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      app_bottom() {
        return <IdleClockView api={api} />
      },
    },
  })
}

export default {
  id: "opencode-essentials-idle-clock",
  tui,
} satisfies TuiPluginModule
