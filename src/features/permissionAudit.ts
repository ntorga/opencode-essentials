import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { sanitizeText } from "../log.ts"
import { resolveEssentialsStatePath } from "../state.ts"
import type { OpenRouterModelId } from "../valueObject/openRouterModelId.ts"
import type { PermissionRequest } from "../valueObject/permissionRequest.ts"
import type { DecisionVerdict } from "./permissionDecision.ts"

// `assistant` is the plugin's own rule answering on the user's behalf, with
// no human and no Jev call — the doom-loop interrupt today.
export type PermissionAuditActor = "classifier" | "user" | "assistant"

export type PermissionAuditReply = "once" | "always" | "reject"

const MAX_AUDIT_PATTERN_CHARS = 2_000

export function resolvePermissionAuditLogPath(): string {
  return path.join(
    path.dirname(resolveEssentialsStatePath()),
    "permission-audit.log",
  )
}

function newAuditBase(request: PermissionRequest, projectDirectory: string) {
  const patterns = request.patterns.map((pattern) =>
    sanitizeText(pattern, MAX_AUDIT_PATTERN_CHARS),
  )
  const truncated = patterns.some(
    (pattern, position) =>
      pattern.length < (request.patterns[position] ?? "").length,
  )
  return {
    time: new Date().toISOString(),
    project: sanitizeText(projectDirectory),
    session: request.sessionID,
    requestID: request.id,
    permission: request.permission,
    patterns,
    ...(truncated ? { truncated: true } : {}),
  }
}

function appendAuditRecord(record: Record<string, unknown>): unknown {
  try {
    const logPath = resolvePermissionAuditLogPath()
    mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 })
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    return undefined
  } catch (failure) {
    return failure
  }
}

export function auditPermissionClassification(input: {
  request: PermissionRequest
  projectDirectory: string
  model: OpenRouterModelId
  probability: number
  explanation?: string
  autoAllowed: boolean
}): unknown {
  return appendAuditRecord({
    ...newAuditBase(input.request, input.projectDirectory),
    type: "classification",
    model: input.model,
    probability: input.probability,
    ...(input.explanation === undefined
      ? {}
      : { explanation: input.explanation }),
    autoAllowed: input.autoAllowed,
  })
}

export function auditPermissionDecision(input: {
  request: PermissionRequest
  projectDirectory: string
  actor: PermissionAuditActor
  reply: PermissionAuditReply
  classifierVerdict?: DecisionVerdict
}): unknown {
  return appendAuditRecord({
    ...newAuditBase(input.request, input.projectDirectory),
    type: "decision",
    actor: input.actor,
    reply: input.reply,
    ...(input.classifierVerdict === undefined
      ? {}
      : { classifier: input.classifierVerdict }),
  })
}
