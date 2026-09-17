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
  hasAdjustableIdleTimeout?: boolean
  // Absent on TUI-only features: the feature has no server-side behavior,
  // so the server entry skips it.
  buildHooks?: (context: FeatureContext) => Promise<Hooks>
}

// A feature that runs on the server must bring its hook builder; callers of
// this type never guard for its absence.
export type ServerSuiteFeature = SuiteFeature & {
  buildHooks: (context: FeatureContext) => Promise<Hooks>
}
