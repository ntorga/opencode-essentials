import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { FEATURES } from "./features/registry.ts"
import {
  isFeatureEnabled,
  readFeatureStates,
  writeFeatureEnabled,
} from "./state.ts"

function stateLabel(enabled: boolean): string {
  return enabled ? "enabled" : "disabled"
}

function showFeatureDialog(api: TuiPluginApi) {
  const { states } = readFeatureStates()
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "OpenCode Essentials",
      options: FEATURES.map((feature) => ({
        title: feature.title,
        value: feature.id,
        description: feature.description,
        footer: stateLabel(isFeatureEnabled(states, feature.id)),
      })),
      onSelect: (item) => {
        const feature = FEATURES.find(
          (candidate) => candidate.id === item.value,
        )
        if (!feature) return
        const enabled = !isFeatureEnabled(
          readFeatureStates().states,
          feature.id,
        )
        try {
          writeFeatureEnabled(feature.id, enabled)
        } catch (failure) {
          api.ui.toast({
            variant: "error",
            message: `Failed to store choice: ${String(failure)}`,
          })
          return
        }
        api.ui.toast({
          variant: enabled ? "success" : "info",
          message: `${feature.title} ${stateLabel(enabled)}`,
        })
        showFeatureDialog(api)
      },
    }),
  )
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "essentials.features",
        title: "Toggle Essentials Features",
        category: "Essentials",
        namespace: "palette",
        run() {
          showFeatureDialog(api)
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("essentials.palette", [
      "essentials.features",
    ]),
  })
}

export default { id: "opencode-essentials-tui", tui } satisfies TuiPluginModule
