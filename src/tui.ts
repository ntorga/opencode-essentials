import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import type { SuiteFeature } from "./features/feature.ts"
import { FEATURES } from "./features/registry.ts"
import { newFeatureId } from "./valueObject/featureId.ts"
import {
  isFeatureEnabled,
  readFeatureStates,
  writeFeatureEnabled,
} from "./state.ts"

function formatEnabledState(enabled: boolean): string {
  return enabled ? "enabled" : "disabled"
}

function toggleFeature(api: TuiPluginApi, feature: SuiteFeature) {
  const shouldEnable = !isFeatureEnabled(
    readFeatureStates().states,
    feature.id,
  )
  try {
    writeFeatureEnabled(feature.id, shouldEnable)
  } catch (failure) {
    api.ui.toast({
      variant: "error",
      message: `FeatureToggleWriteFailed: ${String(failure)}`,
    })
    return
  }
  api.ui.toast({
    variant: shouldEnable ? "success" : "info",
    message: `${feature.title} ${formatEnabledState(shouldEnable)}`,
  })
  showFeatureDialog(api)
}

function selectFeature(api: TuiPluginApi, featureValue: unknown) {
  const featureId = newFeatureId(featureValue)
  if (!featureId) return
  const feature = FEATURES.find(
    (listedFeature) => listedFeature.id === featureId,
  )
  if (!feature) return
  toggleFeature(api, feature)
}

function showFeatureDialog(api: TuiPluginApi) {
  const statesRead = readFeatureStates()
  if (statesRead.error) {
    api.ui.toast({
      variant: "error",
      message: `FeatureStatesReadFailed: ${String(statesRead.error)}`,
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
          isFeatureEnabled(statesRead.states, feature.id),
        ),
      })),
      onSelect: (selectedOption) =>
        selectFeature(api, selectedOption.value),
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
