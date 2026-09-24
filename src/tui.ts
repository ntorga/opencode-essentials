import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import type { SuiteFeature } from "./features/feature.ts"
import { permissionAssistantFeature } from "./features/permission-assistant.ts"
import { DEFAULT_CLASSIFIER_MODEL } from "./features/permissionDecision.ts"
import { FEATURES } from "./features/registry.ts"
import { sanitizeText } from "./log.ts"
import {
  clearFeatureModel,
  clearIdleTimeoutMs,
  clearTokenCeiling,
  isFeatureChosen,
  readEssentialsConfig,
  resolveEffectiveIdleTimeoutMs,
  resolveEffectiveModel,
  resolveEffectiveTokenCeiling,
  writeFeatureEnabled,
  writeFeatureModel,
  writeGlobalEnabled,
  writeIdleTimeoutMs,
  writeTokenCeiling,
} from "./state.ts"
import type { ContextTokens } from "./valueObject/contextTokens.ts"
import {
  DEFAULT_TOKEN_CEILING,
  MAX_TOKEN_CEILING,
  newContextTokens,
  TOKEN_CEILING_PRESETS,
} from "./valueObject/contextTokens.ts"
import type { FeatureId } from "./valueObject/featureId.ts"
import { newFeatureId } from "./valueObject/featureId.ts"
import type { IdleTimeoutMs } from "./valueObject/idleTimeoutMs.ts"
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_TIMEOUT_MINUTES,
  newIdleTimeoutMs,
} from "./valueObject/idleTimeoutMs.ts"
import type { OpenRouterModelId } from "./valueObject/openRouterModelId.ts"
import { newOpenRouterModelId } from "./valueObject/openRouterModelId.ts"

const GLOBAL_ROW_VALUE = "$global"
const TIMEOUT_ROW_PREFIX = "$timeout:"
const CUSTOM_TIMEOUT_VALUE = "$custom"
const CLEAR_TIMEOUT_VALUE = "$clear"
const TIMEOUT_PRESET_MINUTES = [5, 15, 30, 60]
const CLASSIFIER_MODEL_ROW_VALUE = "$classifier-model"
const CUSTOM_CLASSIFIER_MODEL_VALUE = "$custom-classifier-model"
const CLEAR_CLASSIFIER_MODEL_VALUE = "$clear-classifier-model"

const CEILING_ROW_PREFIX = "$ceiling:"
const CEILING_CUSTOM_VALUE = "$custom-ceiling"
const CEILING_CLEAR_VALUE = "$clear-ceiling"
const TIMEOUT_MINUTES_RANGE = `1-${MAX_TIMEOUT_MINUTES}`
const CEILING_INPUT_RANGE = `1-${MAX_TOKEN_CEILING}`
const REJECTED_TIMEOUT_HINT = `EssentialsIdleTimeoutRejected: enter whole minutes from ${TIMEOUT_MINUTES_RANGE}`
const REJECTED_CEILING_HINT = `EssentialsTokenCeilingRejected: enter whole tokens from ${CEILING_INPUT_RANGE}`

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

function trimCeilingUnit(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function formatTokenCeiling(tokens: ContextTokens): string {
  if (tokens >= 1_000_000) return `${trimCeilingUnit(tokens / 1_000_000)}M`
  if (tokens >= 1000) return `${trimCeilingUnit(tokens / 1000)}k`
  return String(tokens)
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
  const storedClassifierModel = config.models[permissionAssistantFeature.id]
  const classifierModelRow = {
    title: "Permission Assistant model",
    value: CLASSIFIER_MODEL_ROW_VALUE,
    description: "OpenRouter Decisions model used for Bash classification.",
    footer: `${resolveEffectiveModel(
      config,
      permissionAssistantFeature.id,
      DEFAULT_CLASSIFIER_MODEL,
    )} (${storedClassifierModel ? "stored" : "default"})`,
  }
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
  const ceilingRows = FEATURES.filter(
    (feature) => feature.hasAdjustableTokenCeiling,
  ).map((feature) => {
    const storedCeiling = config.ceilings[feature.id]
    const effectiveCeiling = resolveEffectiveTokenCeiling(
      config,
      feature.id,
      DEFAULT_TOKEN_CEILING,
    )
    const source = storedCeiling === undefined ? "default" : "stored"
    return {
      title: `${feature.title} token ceiling`,
      value: `${CEILING_ROW_PREFIX}${feature.id}`,
      description:
        "How many tokens of context a session may reach before it compacts.",
      footer: `${formatTokenCeiling(effectiveCeiling)} (${source})`,
    }
  })
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "OpenCode Essentials",
      options: [
        globalRow,
        ...featureRows,
        classifierModelRow,
        ...timeoutRows,
        ...ceilingRows,
      ],
      onSelect: (selectedOption) => selectDialogRow(api, selectedOption.value),
    }),
  )
}

function saveClassifierModel(api: TuiPluginApi, model: OpenRouterModelId) {
  try {
    writeFeatureModel(permissionAssistantFeature.id, model)
  } catch (failure) {
    reportWriteFailure(api, failure)
    return
  }
  api.ui.toast({
    variant: "success",
    message: `Permission Assistant model is ${model}`,
  })
  showFeatureDialog(api)
}

function submitClassifierModel(api: TuiPluginApi, rawValue: string) {
  const model = newOpenRouterModelId(rawValue.trim())
  if (!model) {
    api.ui.toast({
      variant: "error",
      message: "EssentialsClassifierModelRejected: enter provider/model",
    })
    showClassifierModelPrompt(api)
    return
  }
  saveClassifierModel(api, model)
}

function showClassifierModelPrompt(api: TuiPluginApi) {
  const config = readEssentialsConfig().config
  const currentModel = resolveEffectiveModel(
    config,
    permissionAssistantFeature.id,
    DEFAULT_CLASSIFIER_MODEL,
  )
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Permission Assistant OpenRouter model",
      placeholder: "provider/model",
      value: currentModel,
      onConfirm: (value) => submitClassifierModel(api, value),
      onCancel: () => showFeatureDialog(api),
    }),
  )
}

function clearClassifierModel(api: TuiPluginApi) {
  try {
    clearFeatureModel(permissionAssistantFeature.id)
  } catch (failure) {
    reportWriteFailure(api, failure)
    return
  }
  api.ui.toast({
    variant: "info",
    message: `Permission Assistant model is back to ${DEFAULT_CLASSIFIER_MODEL}`,
  })
  showFeatureDialog(api)
}

function pickClassifierModel(api: TuiPluginApi, rowValue: unknown) {
  if (rowValue === CUSTOM_CLASSIFIER_MODEL_VALUE) {
    showClassifierModelPrompt(api)
    return
  }
  if (rowValue !== CLEAR_CLASSIFIER_MODEL_VALUE) return
  clearClassifierModel(api)
}

function showClassifierModelDialog(api: TuiPluginApi) {
  const storedModel =
    readEssentialsConfig().config.models[permissionAssistantFeature.id]
  const options: Array<{ title: string; value: unknown; footer: string }> = [
    {
      title: "Choose a custom model…",
      value: CUSTOM_CLASSIFIER_MODEL_VALUE,
      footer: storedModel ? "stored" : "",
    },
  ]
  if (storedModel) {
    options.push({
      title: `Use Jev default (${DEFAULT_CLASSIFIER_MODEL})`,
      value: CLEAR_CLASSIFIER_MODEL_VALUE,
      footer: "",
    })
  }
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Permission Assistant model",
      options,
      onSelect: (selectedOption) =>
        pickClassifierModel(api, selectedOption.value),
    }),
  )
}

function selectDialogRow(api: TuiPluginApi, rowValue: unknown) {
  if (rowValue === GLOBAL_ROW_VALUE) {
    toggleGlobalEnabled(api)
    return
  }
  if (rowValue === CLASSIFIER_MODEL_ROW_VALUE) {
    showClassifierModelDialog(api)
    return
  }
  if (typeof rowValue === "string" && rowValue.startsWith(TIMEOUT_ROW_PREFIX)) {
    selectTimeoutFeature(api, rowValue.slice(TIMEOUT_ROW_PREFIX.length))
    return
  }
  if (typeof rowValue === "string" && rowValue.startsWith(CEILING_ROW_PREFIX)) {
    selectCeilingFeature(api, rowValue.slice(CEILING_ROW_PREFIX.length))
    return
  }
  const feature = findFeatureByRow(rowValue)
  if (!feature) return
  toggleFeature(api, feature)
}

function selectTimeoutFeature(api: TuiPluginApi, rawFeatureId: string) {
  const feature = findFeatureByRow(rawFeatureId)
  if (!feature?.hasAdjustableIdleTimeout) return
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
      title: `${feature.title}: idle timeout in minutes (${TIMEOUT_MINUTES_RANGE})`,
      placeholder: "30",
      onConfirm: (value: string) => submitCustomTimeout(api, feature, value),
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

function selectCeilingFeature(api: TuiPluginApi, rawFeatureId: string) {
  const feature = findFeatureByRow(rawFeatureId)
  if (!feature?.hasAdjustableTokenCeiling) return
  showTokenCeilingDialog(api, feature)
}

function saveTokenCeiling(
  api: TuiPluginApi,
  feature: SuiteFeature,
  ceiling: ContextTokens,
) {
  try {
    writeTokenCeiling(feature.id, ceiling)
  } catch (failure) {
    reportWriteFailure(api, failure)
    return
  }
  api.ui.toast({
    variant: "success",
    message: `${feature.title} token ceiling is ${formatTokenCeiling(ceiling)}`,
  })
  showFeatureDialog(api)
}

function clearStoredTokenCeiling(api: TuiPluginApi, feature: SuiteFeature) {
  try {
    clearTokenCeiling(feature.id)
  } catch (failure) {
    reportWriteFailure(api, failure)
    return
  }
  api.ui.toast({
    variant: "info",
    message: `${feature.title} token ceiling is back to the default`,
  })
  showFeatureDialog(api)
}

function showTokenCeilingDialog(api: TuiPluginApi, feature: SuiteFeature) {
  const config = readEssentialsConfig().config
  const storedCeiling = config.ceilings[feature.id]
  const options: Array<{ title: string; value: unknown; footer: string }> =
    TOKEN_CEILING_PRESETS.map((ceiling) => ({
      title: formatTokenCeiling(ceiling),
      value: ceiling,
      footer: ceiling === storedCeiling ? "stored" : "",
    }))
  options.push({
    title: "Custom token count…",
    value: CEILING_CUSTOM_VALUE,
    footer: "",
  })
  if (storedCeiling !== undefined) {
    options.push({
      title: `Back to default (${formatTokenCeiling(DEFAULT_TOKEN_CEILING)})`,
      value: CEILING_CLEAR_VALUE,
      footer: "",
    })
  }
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `${feature.title}: token ceiling`,
      options,
      onSelect: (selectedOption) =>
        pickTokenCeiling(api, feature, selectedOption.value),
    }),
  )
}

function pickTokenCeiling(
  api: TuiPluginApi,
  feature: SuiteFeature,
  rowValue: unknown,
) {
  if (rowValue === CEILING_CUSTOM_VALUE) {
    showCustomCeilingPrompt(api, feature)
    return
  }
  if (rowValue === CEILING_CLEAR_VALUE) {
    clearStoredTokenCeiling(api, feature)
    return
  }
  const ceiling = newContextTokens(rowValue)
  if (!ceiling) return
  saveTokenCeiling(api, feature, ceiling)
}

function showCustomCeilingPrompt(api: TuiPluginApi, feature: SuiteFeature) {
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: `${feature.title}: token ceiling in tokens (${CEILING_INPUT_RANGE})`,
      placeholder: "384000",
      onConfirm: (value: string) => submitCustomCeiling(api, feature, value),
      onCancel: () => showFeatureDialog(api),
    }),
  )
}

function submitCustomCeiling(
  api: TuiPluginApi,
  feature: SuiteFeature,
  rawValue: string,
) {
  const ceiling = newContextTokens(Number(rawValue.trim()))
  if (!ceiling) {
    api.ui.toast({
      variant: "error",
      message: REJECTED_CEILING_HINT,
    })
    showCustomCeilingPrompt(api, feature)
    return
  }
  saveTokenCeiling(api, feature, ceiling)
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
