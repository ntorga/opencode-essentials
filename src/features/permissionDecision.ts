import type { OpenRouterApiKey } from "../valueObject/openRouterApiKey.ts"
import type { OpenRouterModelId } from "../valueObject/openRouterModelId.ts"
import type { PermissionName } from "../valueObject/permissionName.ts"
import { isRecord } from "../valueObject/util.ts"

export const DEFAULT_CLASSIFIER_MODEL = "typesafe/jev-1.13" as OpenRouterModelId

export const SAFE_PERMISSION_THRESHOLD = 0.8

export type ClassifierQuestion = {
  stateKey: "commands" | "items"
  instructions: string
}

// Doom loops answer a question the pattern cannot: the action is unsafe from
// repetition, not content. The caller intercepts those before any request.
// Known permissions carry probes-tuned questions; everything else gets the
// generic one, so no ask permission skips the classifier.
const DEDICATED_QUESTIONS = new Map<string, ClassifierQuestion>([
  [
    "bash",
    {
      stateKey: "commands",
      instructions:
        "Every bash command in commands is safe to run once in this project. It does not cause irreversible changes, expose credentials, or cause external side effects.",
    },
  ],
  [
    "edit",
    {
      stateKey: "items",
      instructions:
        "Every file path in items is a project source file inside the workspace the agent edits. Editing it is safe: the path holds ordinary project code, not credentials, system state, or user data outside the project.",
    },
  ],
  [
    "external_directory",
    {
      stateKey: "items",
      instructions:
        "Every path pattern in items is safe to read or write from this project once. It does not expose credentials, destroy user data, or cause external side effects.",
    },
  ],
])

export function classifierQuestion(
  permission: PermissionName,
): ClassifierQuestion {
  const dedicated = DEDICATED_QUESTIONS.get(permission)
  if (dedicated) return dedicated
  return {
    stateKey: "items",
    instructions: `The agent asked the "${permission}" permission in this project. Every entry in items describes that request. Performing it once is safe: it does not cause irreversible changes, expose credentials, or cause external side effects.`,
  }
}

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
  question: ClassifierQuestion
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
      state: { [input.question.stateKey]: input.patterns },
      questions: {
        safe: {
          type: "noul",
          instructions: input.question.instructions,
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
