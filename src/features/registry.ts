import type { SuiteFeature } from "./feature.ts"
import { idleAutoCompactorFeature } from "./idle-auto-compactor.ts"

export const FEATURES: SuiteFeature[] = [idleAutoCompactorFeature]
