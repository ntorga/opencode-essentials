import type { SuiteFeature } from "./feature.ts"
import { idleAutoCompactorFeature } from "./idle-auto-compactor.ts"
import { idleClockFeature } from "./idle-clock.ts"

export const FEATURES: SuiteFeature[] = [
  idleAutoCompactorFeature,
  idleClockFeature,
]
