import type {
  Hooks,
  Plugin,
  PluginModule,
  PluginOptions,
} from "@opencode-ai/plugin"
import { combineHooks } from "./hooks.ts"
import { FEATURES } from "./features/registry.ts"
import { writeLog } from "./log.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const server: Plugin = async (input, options) => {
  const features = options?.features
  const perFeature: Record<string, Record<string, unknown>> = {}
  if (isRecord(features)) {
    for (const [featureID, value] of Object.entries(features)) {
      if (isRecord(value)) {
        perFeature[featureID] = value
        continue
      }
      await writeLog(input.client, "warn", "InvalidFeatureOptions", {
        featureID,
      })
    }
  }

  const featureHooks: Hooks[] = []
  for (const feature of FEATURES) {
    featureHooks.push(
      await feature.buildHooks({
        client: input.client,
        options: perFeature[feature.id] ?? {},
      }),
    )
  }
  return combineHooks(featureHooks)
}

export default { id: "opencode-essentials", server } satisfies PluginModule
