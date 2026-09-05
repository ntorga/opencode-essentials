import type {
  Hooks,
  Plugin,
  PluginInput,
  PluginModule,
} from "@opencode-ai/plugin"
import type { FeatureId } from "./valueObject/featureId.ts"
import { newFeatureId } from "./valueObject/featureId.ts"
import { isRecord } from "./valueObject/util.ts"
import { combineHooks } from "./hooks.ts"
import { FEATURES } from "./features/registry.ts"
import { writeLog } from "./log.ts"

async function validFeatureOptions(
  input: PluginInput,
  features: unknown,
): Promise<Partial<Record<FeatureId, Record<string, unknown>>>> {
  const perFeature: Partial<Record<FeatureId, Record<string, unknown>>> =
    Object.create(null)
  if (!isRecord(features)) return perFeature
  for (const [entryKey, entryValue] of Object.entries(features)) {
    const featureId = newFeatureId(entryKey)
    if (featureId && isRecord(entryValue)) {
      perFeature[featureId] = entryValue
      continue
    }
    await writeLog(input.client, "warn", "InvalidFeatureOptions", {
      featureId: entryKey,
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
