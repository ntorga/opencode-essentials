import type { SuiteFeature } from "./feature.ts"
import { idleAutoCompactorFeature } from "./idle-auto-compactor.ts"
import { idleClockFeature } from "./idle-clock.ts"
import { permissionAssistantFeature } from "./permission-assistant.ts"
import { reasoningLoopGuardFeature } from "./reasoning-loop-guard.ts"
import { tokenCeilingCompactorFeature } from "./token-ceiling-compactor.ts"
import { usageStatusFeature } from "./usage-status.ts"

export const FEATURES: SuiteFeature[] = [
  idleAutoCompactorFeature,
  tokenCeilingCompactorFeature,
  idleClockFeature,
  permissionAssistantFeature,
  reasoningLoopGuardFeature,
  usageStatusFeature,
]
