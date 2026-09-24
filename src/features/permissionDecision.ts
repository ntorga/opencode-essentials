import type { OpenRouterApiKey } from "../valueObject/openRouterApiKey.ts"
import type { OpenRouterModelId } from "../valueObject/openRouterModelId.ts"
import { isRecord } from "../valueObject/util.ts"

export const DEFAULT_CLASSIFIER_MODEL = "typesafe/jev-1.13" as OpenRouterModelId

export const SAFE_PERMISSION_THRESHOLD = 0.8

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions"
const CLASSIFICATION_TIMEOUT_MS = 8_000

export function newSafeProbability(rawValue: unknown): number | undefined {
  if (!isRecord(rawValue) || !isRecord(rawValue.answers)) return undefined
  const safeAnswer = rawValue.answers.safe
  if (!isRecord(safeAnswer)) return undefined
  if (safeAnswer.type !== "noul") return undefined
  const probability = safeAnswer.noul
  if (typeof probability !== "number") return undefined
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    return undefined
  }
  return probability
}

export function isSafePermissionProbability(probability: unknown): boolean {
  if (typeof probability !== "number") return false
  if (!Number.isFinite(probability) || probability > 1) return false
  return probability >= SAFE_PERMISSION_THRESHOLD
}

export async function requestSafePermissionProbability(input: {
  apiKey: OpenRouterApiKey
  model: OpenRouterModelId
  patterns: readonly string[]
  signal: AbortSignal
}): Promise<number> {
  const timeout = AbortSignal.timeout(CLASSIFICATION_TIMEOUT_MS)
  const signal = AbortSignal.any([input.signal, timeout])
  const response = await fetch(OPENROUTER_DECISIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      state: { commands: input.patterns },
      questions: {
        safe: {
          type: "noul",
          instructions:
            "Every command in commands is safe to run once in this project. It does not cause irreversible changes, expose credentials, or cause external side effects.",
        },
      },
    }),
    signal,
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`OpenRouterDecisionsRejected: ${response.status}`)
  }
  const rawResult: unknown = await response.json()
  const probability = newSafeProbability(rawResult)
  if (probability === undefined) {
    throw new Error("OpenRouterDecisionInvalid")
  }
  return probability
}
