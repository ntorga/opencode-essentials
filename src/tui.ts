import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import type { SuiteFeature } from "./features/feature.ts"
import { FEATURES } from "./features/registry.ts"
import {
  isFeatureEnabled,
  readFeatureStates,
  writeFeatureEnabled,
} from "./state.ts"

function formatEnabledState(enabled: boolean): string {
  return enabled ? "enabled" : "disabled"
}

function toggleFeature(api: TuiPluginApi, feature: SuiteFeature) {
  const desired = !isFeatureEnabled(
    readFeatureStates().states,
    feature.id,
  )
  try {
    writeFeatureEnabled(feature.id, desired)
  } catch (failure) {
    api.ui.toast({
      variant: "error",
      message: `FeatureToggleWriteFailed: ${String(failure)}`,
    })
    return
  }
  api.ui.toast({
    variant: desired ? "success" : "info",
    message: `${feature.title} ${formatEnabledState(desired)}`,
  })
  showFeatureDialog(api)
}

function selectFeature(api: TuiPluginApi, featureID: unknown) {
  const feature = FEATURES.find((candidate) => candidate.id === featureID)
  if (!feature) return
  toggleFeature(api, feature)
}

function showFeatureDialog(api: TuiPluginApi) {
  const read = readFeatureStates()
  if (read.error) {
    api.ui.toast({
      variant: "error",
      message: `FeatureStatesReadFailed: ${String(read.error)}`,
    })
  }
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "OpenCode Essentials",
      options: FEATURES.map((feature) => ({
        title: feature.title,
        value: feature.id,
        description: feature.description,
        footer: formatEnabledState(
          isFeatureEnabled(read.states, feature.id),
        ),
      })),
      onSelect: (item) => selectFeature(api, item.value),
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
