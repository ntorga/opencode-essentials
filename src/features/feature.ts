import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { FeatureId } from "../valueObject/featureId.ts"

export type FeatureContext = {
  client: PluginInput["client"]
  options: Record<string, unknown>
}

export type SuiteFeature = {
  id: FeatureId
  title: string
  description: string
  buildHooks: (context: FeatureContext) => Promise<Hooks>
}
