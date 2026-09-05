import type { Hooks, PluginInput } from "@opencode-ai/plugin"

export type FeatureContext = {
  client: PluginInput["client"]
  options: Record<string, unknown>
}

export type SuiteFeature = {
  id: string
  title: string
  description: string
  buildHooks: (context: FeatureContext) => Promise<Hooks>
}
