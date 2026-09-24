import type { ContextTokens } from "../valueObject/contextTokens.ts"
import { newContextTokens } from "../valueObject/contextTokens.ts"
import type { ModelId } from "../valueObject/modelId.ts"
import { newModelId } from "../valueObject/modelId.ts"
import type { ModelRef } from "../valueObject/modelRef.ts"
import type { ProviderId } from "../valueObject/providerId.ts"
import { newProviderId } from "../valueObject/providerId.ts"
import { isRecord } from "../valueObject/util.ts"

// The measured context of the newest answer, ready for ceiling comparison.
export type CeilingTurn = {
  model: ModelRef
  usageTokens: number
}

export type CeilingClamp = {
  ceiling: ContextTokens
  clampedFrom?: ContextTokens
}

// Summands and the accumulated total are both checked: a negative token
// count is outside the host's usage contract and poisons the measurement
// downward, finite parts can still overflow to Infinity (1e308 + 1e308),
// and either case would steer the compaction decision with an unusable
// number. An unusable measurement abandons the check.
function sumFiniteNumbers(values: unknown[]): number | undefined {
  let total = 0
  for (const value of values) {
    if (typeof value !== "number") return undefined
    if (!Number.isFinite(value) || value < 0) return undefined
    total += value
  }
  if (!Number.isFinite(total)) return undefined
  return total
}

// OpenCode reports usage per completed assistant message; the host's own
// overflow check sums input, output, cache.read, and cache.write from
// message info.tokens. Reasoning tokens are absent from that sum, so they
// are absent here too.
function measureTokens(rawTokens: unknown): number | undefined {
  if (!isRecord(rawTokens)) return undefined
  const cache = isRecord(rawTokens.cache) ? rawTokens.cache : {}
  return sumFiniteNumbers([
    rawTokens.input,
    rawTokens.output,
    cache.read,
    cache.write,
  ])
}

function readModelPair(rawInfo: Record<string, unknown>): ModelRef | undefined {
  const providerId = newProviderId(rawInfo.providerID)
  const modelId = newModelId(rawInfo.modelID)
  if (!providerId || !modelId) return undefined
  return { providerId, modelId }
}

// The newest completed, non-summary assistant message is the measurement
// point: its usage describes the context that produced it, and its model is
// the model that will run the next turn. A summary turn rewrites the
// context, so measuring it would compare a rewritten number against the
// ceiling that triggered the rewrite. When that message carries no usable
// model or no finite token numbers there is no answer to act on, so the
// whole check is abandoned rather than falling back to an older turn whose
// model may no longer be the session's.
export function resolveCeilingTurn(
  rawMessages: unknown,
): CeilingTurn | undefined {
  if (!Array.isArray(rawMessages)) return undefined
  for (let position = rawMessages.length - 1; position >= 0; position--) {
    const entry = rawMessages[position]
    if (!isRecord(entry) || !isRecord(entry.info)) continue
    const info = entry.info
    if (info.role !== "assistant") continue
    if (info.summary === true) continue
    if (!isRecord(info.time)) continue
    if (typeof info.time.completed !== "number") continue
    const model = readModelPair(info)
    const usageTokens = measureTokens(info.tokens)
    if (!model || usageTokens === undefined) return undefined
    return { model, usageTokens }
  }
  return undefined
}

// The model context limit comes from the host's provider list: an object
// whose `all` array lists providers, each carrying a models record keyed
// by model id.
export function resolveProviderContextLimit(
  rawProviderList: unknown,
  providerId: ProviderId,
  modelId: ModelId,
): number | undefined {
  if (!isRecord(rawProviderList) || !Array.isArray(rawProviderList.all)) {
    return undefined
  }
  for (const rawProvider of rawProviderList.all) {
    if (!isRecord(rawProvider) || rawProvider.id !== providerId) continue
    if (!isRecord(rawProvider.models)) return undefined
    const rawModel = rawProvider.models[modelId]
    if (!isRecord(rawModel) || !isRecord(rawModel.limit)) return undefined
    const context = rawModel.limit.context
    if (typeof context !== "number" || !Number.isFinite(context)) {
      return undefined
    }
    return context
  }
  return undefined
}

// Below this window size no model can hold a system prompt plus a tool
// loop, so such a limit is corrupt host data, not a small model. Clamping
// to it would compact every turn of the session.
const MIN_PLAUSIBLE_MODEL_WINDOW = 1024

// The small-context guard: a ceiling above the model's window is
// meaningless, so the window wins. A missing, zero, or implausibly small
// limit is treated as unknown — the host itself treats context 0 as "never
// overflow on its own" — and the requested ceiling stays in play.
export function clampCeilingToModel(
  requested: ContextTokens,
  contextLimit: number | undefined,
): CeilingClamp {
  if (contextLimit === undefined || contextLimit < MIN_PLAUSIBLE_MODEL_WINDOW) {
    return { ceiling: requested }
  }
  const flooredLimit = newContextTokens(Math.floor(contextLimit))
  if (!flooredLimit || flooredLimit >= requested) {
    return { ceiling: requested }
  }
  return { ceiling: flooredLimit, clampedFrom: requested }
}
