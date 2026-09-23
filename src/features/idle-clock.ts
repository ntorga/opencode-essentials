import type { FeatureId } from "../valueObject/featureId.ts"
import type { SuiteFeature } from "./feature.ts"

// The idle clock is TUI-only: it renders inside the TUI process from the
// host's synced state, so the entry carries no buildHooks and the server
// skips it. The id still rides the shared state file, so the master switch
// and the /essentials row gate it like every other feature.
export const idleClockFeature: SuiteFeature = {
  id: "idle-clock" as FeatureId,
  title: "Idle Session Clock",
  description: "Shows how long the open session has waited for your input.",
}
