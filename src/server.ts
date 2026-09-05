import type {
  Hooks,
  Plugin,
  PluginInput,
  PluginModule,
} from "@opencode-ai/plugin"
import { combineHooks } from "./hooks.ts"
import { FEATURES } from "./features/registry.ts"
import { writeLog } from "./log.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function validFeatureOptions(
  input: PluginInput,
  features: unknown,
): Promise<Record<string, Record<string, unknown>>> {
  const perFeature: Record<string, Record<string, unknown>> = Object.create(
    null,
  )
  if (!isRecord(features)) return perFeature
  for (const [featureID, value] of Object.entries(features)) {
    if (isRecord(value)) {
      perFeature[featureID] = value
      continue
    }
    await writeLog(input.client, "warn", "InvalidFeatureOptions", {
      featureID,
    })
  }
  return perFeature
}

const server: Plugin = async (input, options) => {
  const perFeature = await validFeatureOptions(input, options?.features)
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
