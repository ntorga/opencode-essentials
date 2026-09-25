import type { OpenRouterApiKey } from "../valueObject/openRouterApiKey.ts"
import type { OpenRouterModelId } from "../valueObject/openRouterModelId.ts"
import type { PermissionName } from "../valueObject/permissionName.ts"
import { isRecord } from "../valueObject/util.ts"

export const DEFAULT_CLASSIFIER_MODEL = "typesafe/jev-1.13" as OpenRouterModelId

export const SAFE_PERMISSION_THRESHOLD = 0.8

export type ClassifierQuestion = {
  stateKey: "commands" | "items"
  answerKey: "safe" | "stuck"
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
      answerKey: "safe",
      instructions:
        "Every bash command in commands is safe to run once in this project. It does not cause irreversible changes, expose credentials, or cause external side effects.",
    },
  ],
  [
    "edit",
    {
      stateKey: "items",
      answerKey: "safe",
      instructions:
        "Every file path in items is a project source file inside the workspace the agent edits. Editing it is safe: the path holds ordinary project code, not credentials, system state, or user data outside the project.",
    },
  ],
  [
    "external_directory",
    {
      stateKey: "items",
      answerKey: "safe",
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
    answerKey: "safe",
    instructions: `The agent asked the "${permission}" permission in this project. Every entry in items describes that request. Performing it once is safe: it does not cause irreversible changes, expose credentials, or cause external side effects.`,
  }
}

// A repeated reasoning tail answers a different question than the permission
// classifier: the text is not unsafe, the model producing it has stalled.
export const REASONING_LOOP_QUESTION: ClassifierQuestion = {
  stateKey: "items",
  answerKey: "stuck",
  instructions:
    "Every entry in items is a text fragment the model wrote several times in a row inside one reasoning block. The model is stuck in a reasoning spiral: it keeps re-deriving the same content without progress, and its response will not finish usefully on its own.",
}

export const REASONING_LOOP_CONFIRM_PROBABILITY = 0.8

function newValidProbability(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined
  if (!Number.isFinite(value) || value < 0 || value > 1) return undefined
  return value
}

// One range contract for every probability read from the wire or a call
// site; questions differ only in the threshold they compare against.
function isProbabilityAtLeast(value: unknown, threshold: number): boolean {
  const probability = newValidProbability(value)
  return probability !== undefined && probability >= threshold
}

export function isSafePermissionProbability(probability: unknown): boolean {
  return isProbabilityAtLeast(probability, SAFE_PERMISSION_THRESHOLD)
}

export function isReasoningLoopProbability(probability: unknown): boolean {
  return isProbabilityAtLeast(probability, REASONING_LOOP_CONFIRM_PROBABILITY)
}

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions"
const CLASSIFICATION_TIMEOUT_MS = 8_000

export function newDecisionProbability(
  rawValue: unknown,
  answerKey: string,
): number | undefined {
  if (!isRecord(rawValue) || !isRecord(rawValue.answers)) return undefined
  const answer = rawValue.answers[answerKey]
  if (!isRecord(answer)) return undefined
  if (answer.type !== "noul") return undefined
  return newValidProbability(answer.noul)
}

export async function requestDecisionProbability(input: {
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
        [input.question.answerKey]: {
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
  const probability = newDecisionProbability(
    rawResult,
    input.question.answerKey,
  )
  if (probability === undefined) {
    throw new Error("OpenRouterDecisionInvalid")
  }
  return probability
}
