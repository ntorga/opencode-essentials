import type { FeatureId } from "../valueObject/featureId.ts"
import type { SuiteFeature } from "./feature.ts"

export const permissionAssistantFeature: SuiteFeature = {
  id: "permission-assistant" as FeatureId,
  title: "Permission Assistant",
  description:
    "Checks pending Bash permissions with Jev and notifies you when they need input.",
}
