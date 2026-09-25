import type { FeatureId } from "../valueObject/featureId.ts"
import type { SuiteFeature } from "./feature.ts"

export const usageStatusFeature: SuiteFeature = {
  id: "usage-status" as FeatureId,
  title: "Response Usage Status",
  description:
    "Shows the provider health verdict, token rate, and response waits in the status bar.",
}
