import type { FeatureId } from "../valueObject/featureId.ts"
import type { SuiteFeature } from "./feature.ts"

export const usageStatusFeature: SuiteFeature = {
  id: "usage-status" as FeatureId,
  title: "Response Usage Status",
  description:
    "Shows token rate, latency, response time, and cost at the bottom of the TUI.",
}
