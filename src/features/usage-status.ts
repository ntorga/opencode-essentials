import type { FeatureId } from "../valueObject/featureId.ts"
import type { SuiteFeature } from "./feature.ts"

export const usageStatusFeature: SuiteFeature = {
  id: "usage-status" as FeatureId,
  title: "Response Usage Status",
  description: "Shows token rate and response latency in the status bar.",
}
