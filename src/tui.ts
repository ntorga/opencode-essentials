import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import type { SuiteFeature } from "./features/feature.ts"
import { FEATURES } from "./features/registry.ts"
import type { FeatureId } from "./valueObject/featureId.ts"
import { newFeatureId } from "./valueObject/featureId.ts"
import type { IdleTimeoutMs } from "./valueObject/idleTimeoutMs.ts"
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_TIMEOUT_MINUTES,
  newIdleTimeoutMs,
} from "./valueObject/idleTimeoutMs.ts"
import { sanitizeText } from "./log.ts"
import {
  clearIdleTimeoutMs,
  isFeatureChosen,
  readEssentialsConfig,
  resolveEffectiveIdleTimeoutMs,
  writeFeatureEnabled,
  writeGlobalEnabled,
  writeIdleTimeoutMs,
} from "./state.ts"

const GLOBAL_ROW_VALUE = "$global"
const TIMEOUT_ROW_PREFIX = "$timeout:"
const CUSTOM_TIMEOUT_VALUE = "$custom"
const CLEAR_TIMEOUT_VALUE = "$clear"
const TIMEOUT_PRESET_MINUTES = [5, 15, 30, 60]

const TIMEOUT_MINUTES_RANGE = `1-${MAX_TIMEOUT_MINUTES}`
const REJECTED_TIMEOUT_HINT =
  `EssentialsIdleTimeoutRejected: enter whole minutes from ${TIMEOUT_MINUTES_RANGE}`

function formatEnabledState(enabled: boolean): string {
  return enabled ? "enabled" : "disabled"
}

function formatDuration(idleTimeoutMs: IdleTimeoutMs): string {
  if (idleTimeoutMs < 60_000) return "under a minute"
  const totalMinutes = Math.round(idleTimeoutMs / 60_000)
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const restMinutes = totalMinutes % 60
  if (restMinutes === 0) return `${hours} h`
  return `${hours} h ${restMinutes} min`
}

function reportWriteFailure(api: TuiPluginApi, failure: unknown) {
  api.ui.toast({
    variant: "error",
    message: sanitizeText(`EssentialsConfigWriteFailed: ${String(failure)}`),
  })
}

function findSuiteFeature(featureId: FeatureId): SuiteFeature | undefined {
  return FEATURES.find((listedFeature) => listedFeature.id === featureId)
}

function findFeatureByRow(featureValue: unknown): SuiteFeature | undefined {
  const featureId = newFeatureId(featureValue)
  if (!featureId) return undefined
  return findSuiteFeature(featureId)
}

function toggleFeature(api: TuiPluginApi, feature: SuiteFeature) {
  const config = readEssentialsConfig().config
  const shouldEnable = !isFeatureChosen(config, feature.id)
  try {
    writeFeatureEnabled(feature.id, shouldEnable)
  } catch (failure) {
    reportWriteFailure(api, failure)
    return
  }
  api.ui.toast({
    variant: shouldEnable ? "success" : "info",
    message: `${feature.title} ${formatEnabledState(shouldEnable)}`,
  })
  showFeatureDialog(api)
}

function toggleGlobalEnabled(api: TuiPluginApi) {
  const shouldEnable = !readEssentialsConfig().config.isEnabled
  try {
    writeGlobalEnabled(shouldEnable)
  } catch (failure) {
    reportWriteFailure(api, failure)
    return
  }
  api.ui.toast({
    variant: shouldEnable ? "success" : "info",
    message: `Essentials ${formatEnabledState(shouldEnable)}`,
  })
  showFeatureDialog(api)
}

function showFeatureDialog(api: TuiPluginApi) {
  const configRead = readEssentialsConfig()
  if (configRead.error) {
    api.ui.toast({
      variant: "error",
      message: sanitizeText(
        `EssentialsConfigReadFailed: ${String(configRead.error)}`,
      ),
    })
  }
  const config = configRead.config
  const globalRow = {
    title: "All features",
    value: GLOBAL_ROW_VALUE,
    description: "Master switch. Per-feature choices are kept.",
    footer: formatEnabledState(config.isEnabled),
  }
  const featureRows = FEATURES.map((feature) => ({
    title: feature.title,
    value: feature.id,
    description: feature.description,
    footer: formatEnabledState(isFeatureChosen(config, feature.id)),
  }))
  const timeoutRows = FEATURES.filter(
    (feature) => feature.hasAdjustableIdleTimeout,
  ).map((feature) => {
    const storedMs = config.timeouts[feature.id]
    const effectiveMs = resolveEffectiveIdleTimeoutMs(
      config,
      feature.id,
      DEFAULT_IDLE_TIMEOUT_MS,
    )
    const source = storedMs === undefined ? "default" : "stored"
    return {
      title: `${feature.title} idle timeout`,
      value: `${TIMEOUT_ROW_PREFIX}${feature.id}`,
      description: "How long a session must stay quiet before it compacts.",
      footer: `${formatDuration(effectiveMs)} (${source})`,
    }
  })
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "OpenCode Essentials",
      options: [globalRow, ...featureRows, ...timeoutRows],
      onSelect: (selectedOption) =>
        selectDialogRow(api, selectedOption.value),
    }),
  )
}

function selectDialogRow(api: TuiPluginApi, rowValue: unknown) {
  if (rowValue === GLOBAL_ROW_VALUE) {
    toggleGlobalEnabled(api)
    return
  }
  if (
    typeof rowValue === "string" &&
    rowValue.startsWith(TIMEOUT_ROW_PREFIX)
  ) {
    selectTimeoutFeature(api, rowValue.slice(TIMEOUT_ROW_PREFIX.length))
    return
  }
  const feature = findFeatureByRow(rowValue)
  if (!feature) return
  toggleFeature(api, feature)
}

function selectTimeoutFeature(api: TuiPluginApi, rawFeatureId: string) {
  const feature = findFeatureByRow(rawFeatureId)
  if (!feature || !feature.hasAdjustableIdleTimeout) return
  showIdleTimeoutDialog(api, feature)
}

function saveIdleTimeout(
  api: TuiPluginApi,
  feature: SuiteFeature,
  timeout: IdleTimeoutMs,
) {
  try {
    writeIdleTimeoutMs(feature.id, timeout)
  } catch (failure) {
    reportWriteFailure(api, failure)
    return
  }
  api.ui.toast({
    variant: "success",
    message: `${feature.title} idle timeout is ${formatDuration(timeout)}`,
  })
  showFeatureDialog(api)
}

function clearIdleTimeout(api: TuiPluginApi, feature: SuiteFeature) {
  try {
    clearIdleTimeoutMs(feature.id)
  } catch (failure) {
    reportWriteFailure(api, failure)
    return
  }
  api.ui.toast({
    variant: "info",
    message: `${feature.title} idle timeout is back to the default`,
  })
  showFeatureDialog(api)
}

function showIdleTimeoutDialog(api: TuiPluginApi, feature: SuiteFeature) {
  const config = readEssentialsConfig().config
  const storedMs = config.timeouts[feature.id]
  const currentMs = resolveEffectiveIdleTimeoutMs(
    config,
    feature.id,
    DEFAULT_IDLE_TIMEOUT_MS,
  )
  const options: Array<{ title: string; value: unknown; footer: string }> =
    TIMEOUT_PRESET_MINUTES.map((minutes) => {
      const timeoutMs = (minutes * 60_000) as IdleTimeoutMs
      return {
        title: formatDuration(timeoutMs),
        value: timeoutMs,
        footer: timeoutMs === storedMs ? "stored" : "",
      }
    })
  options.push({
    title: "Custom minutes…",
    value: CUSTOM_TIMEOUT_VALUE,
    footer: "",
  })
  if (storedMs !== undefined) {
    options.push({
      title: `Back to default (${formatDuration(DEFAULT_IDLE_TIMEOUT_MS)})`,
      value: CLEAR_TIMEOUT_VALUE,
      footer: "",
    })
  }
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `${feature.title}: idle timeout`,
      options,
      onSelect: (selectedOption) =>
        pickIdleTimeout(api, feature, selectedOption.value),
    }),
  )
}

function pickIdleTimeout(
  api: TuiPluginApi,
  feature: SuiteFeature,
  rowValue: unknown,
) {
  if (rowValue === CUSTOM_TIMEOUT_VALUE) {
    showCustomTimeoutPrompt(api, feature)
    return
  }
  if (rowValue === CLEAR_TIMEOUT_VALUE) {
    clearIdleTimeout(api, feature)
    return
  }
  const timeout = newIdleTimeoutMs(rowValue)
  if (!timeout) return
  saveIdleTimeout(api, feature, timeout)
}

function showCustomTimeoutPrompt(api: TuiPluginApi, feature: SuiteFeature) {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title:
        `${feature.title}: idle timeout in minutes (${TIMEOUT_MINUTES_RANGE})`,
      placeholder: "30",
      onConfirm: (value: string) =>
        submitCustomTimeout(api, feature, value),
      onCancel: () => showFeatureDialog(api),
    }),
  )
}

function minutesToTimeout(rawMinutes: number): IdleTimeoutMs | undefined {
  if (!Number.isInteger(rawMinutes)) return undefined
  if (rawMinutes < 1 || rawMinutes > MAX_TIMEOUT_MINUTES) return undefined
  return newIdleTimeoutMs(rawMinutes * 60_000)
}

function submitCustomTimeout(
  api: TuiPluginApi,
  feature: SuiteFeature,
  rawValue: string,
) {
  const timeout = minutesToTimeout(Number(rawValue.trim()))
  if (!timeout) {
    api.ui.toast({
      variant: "error",
      message: REJECTED_TIMEOUT_HINT,
    })
    showCustomTimeoutPrompt(api, feature)
    return
  }
  saveIdleTimeout(api, feature, timeout)
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "essentials.features",
        title: "Toggle Essentials Features",
        category: "Essentials",
        namespace: "palette",
        slashName: "essentials",
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
