import type { SuiteFeature } from "./feature.ts"
import { idleAutoCompactorFeature } from "./idle-auto-compactor.ts"
import { idleClockFeature } from "./idle-clock.ts"
import { tokenCeilingCompactorFeature } from "./token-ceiling-compactor.ts"

export const FEATURES: SuiteFeature[] = [
  idleAutoCompactorFeature,
  tokenCeilingCompactorFeature,
  idleClockFeature,
]
