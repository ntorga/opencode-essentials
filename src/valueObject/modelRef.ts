import type { ModelId } from "./modelId.ts"
import type { ProviderId } from "./providerId.ts"
import { newModelId } from "./modelId.ts"
import { newProviderId } from "./providerId.ts"
import { isRecord } from "./util.ts"

// OpenCode emits the model pair as `providerID`/`modelID` on a message.
// Those key spellings belong to the host, so the constructor reads them as-is
// and re-exposes them under this project's naming.
const SDK_PROVIDER_KEY = "providerID"
const SDK_MODEL_KEY = "modelID"

export type ModelRef = {
  providerId: ProviderId
  modelId: ModelId
}

export function newModelRef(rawModel: unknown): ModelRef | undefined {
  if (!isRecord(rawModel)) return undefined
  const providerId = newProviderId(rawModel[SDK_PROVIDER_KEY])
  const modelId = newModelId(rawModel[SDK_MODEL_KEY])
  if (!providerId || !modelId) return undefined
  return { providerId, modelId }
}
