import type { FeatureId } from "../valueObject/featureId.ts"
import type { SuiteFeature } from "./feature.ts"

export const permissionAssistantFeature: SuiteFeature = {
  id: "permission-assistant" as FeatureId,
  title: "Permission Assistant",
  description:
    "Checks every pending permission request with Jev before it reaches you, interrupts doom loops with a correction, and notifies you when it cannot decide.",
}
