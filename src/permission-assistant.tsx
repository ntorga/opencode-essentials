import { type ChildProcess, spawn } from "node:child_process"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { newAutoAllowReply } from "./features/autoAllowPolicy.ts"
import { buildPermissionNotificationArguments } from "./features/notificationText.ts"
import { permissionAssistantFeature } from "./features/permission-assistant.ts"
import {
  auditPermissionClassification,
  auditPermissionDecision,
  type PermissionAuditActor,
  type PermissionAuditReply,
} from "./features/permissionAudit.ts"
import {
  type ClassifierQuestion,
  classifierQuestion,
  DEFAULT_CLASSIFIER_MODEL,
  type DecisionVerdict,
  isSafePermissionProbability,
  requestDecisionVerdict,
} from "./features/permissionDecision.ts"
import { sanitizeText } from "./log.ts"
import { readOpenRouterApiKey } from "./openRouterAuth.ts"
import {
  isFeatureEnabled,
  readEssentialsConfig,
  resolveEffectiveAutoAllowReply,
  resolveEffectiveModel,
} from "./state.ts"
import type { OpenRouterModelId } from "./valueObject/openRouterModelId.ts"
import type { PermissionName } from "./valueObject/permissionName.ts"
import { DEFAULT_AUTO_ALLOW_REPLY } from "./valueObject/permissionReplyMode.ts"
import type { PermissionRequest } from "./valueObject/permissionRequest.ts"
import { newPermissionRequest } from "./valueObject/permissionRequest.ts"
import type { PermissionRequestId } from "./valueObject/permissionRequestId.ts"
import { newPermissionRequestId } from "./valueObject/permissionRequestId.ts"

const MAX_CLASSIFIER_PATTERNS = 8
const MAX_CLASSIFIER_PATTERN_CHARS = 2_000
const ALLOW_ACTION = "allow"
const ALWAYS_ACTION = "always"
const DOOM_LOOP_PERMISSION = "doom_loop" as PermissionName
const DOOM_LOOP_CORRECTION =
  "The doom-loop guard stopped this action: you are repeating the same call. Do not retry it unchanged. Change your approach or report the blocker and what you tried."

type PendingPermission = {
  request: PermissionRequest
  abort: AbortController
  notification?: ChildProcess
  hasReplied: boolean
  authorizedActor?: PermissionAuditActor
  classifierVerdict?: DecisionVerdict
  fallbackWasShown: boolean
}

type PermissionAssistantState = {
  missingCredentialWasLogged: boolean
  authStoreFailureWasLogged: boolean
}

function isCurrentPermission(
  pendingPermissions: Map<PermissionRequestId, PendingPermission>,
  permission: PendingPermission,
): boolean {
  return pendingPermissions.get(permission.request.id) === permission
}

function classifierQuestionFor(
  request: PermissionRequest,
): ClassifierQuestion | undefined {
  if (request.patterns.length === 0) return undefined
  if (request.patterns.length > MAX_CLASSIFIER_PATTERNS) return undefined
  const fitsLimit = request.patterns.every(
    (pattern) => pattern.length <= MAX_CLASSIFIER_PATTERN_CHARS,
  )
  return fitsLimit ? classifierQuestion(request.permission) : undefined
}

function formatPermissionNotificationMessage(
  request: PermissionRequest,
): string {
  const requestedAction = request.patterns.join(" · ") || request.permission
  return sanitizeText(requestedAction)
}

async function logPermissionFailure(
  api: TuiPluginApi,
  message: string,
  failure: unknown,
): Promise<void> {
  const fallbackMessage = sanitizeText(`${message}: ${String(failure)}`)
  try {
    const result = await api.client.app.log({
      service: "opencode-essentials",
      level: "warn",
      message,
      extra: { error: sanitizeText(failure) },
    })
    if (!("error" in result) || !result.error) return
  } catch {
    api.ui.toast({ variant: "warning", message: fallbackMessage })
    return
  }
  api.ui.toast({ variant: "warning", message: fallbackMessage })
}

function canShowPermissionNotification(api: TuiPluginApi): boolean {
  return (
    api.tuiConfig.attention.enabled && api.tuiConfig.attention.notifications
  )
}

function showAttentionNotification(
  api: TuiPluginApi,
  permission: PendingPermission | undefined,
): void {
  if (!canShowPermissionNotification(api)) return
  if (permission?.fallbackWasShown) return
  if (permission) permission.fallbackWasShown = true

  const message = permission
    ? formatPermissionNotificationMessage(permission.request)
    : "A permission request needs your input."
  void api.attention
    .notify({
      title: "OpenCode needs permission",
      message,
      notification: { when: "always" },
      sound: { name: "permission", when: "always" },
    })
    .then((result) => {
      if (result.ok) return
      void logPermissionFailure(
        api,
        "PermissionAttentionNotificationFailed",
        result.skipped ?? "Notification was not shown",
      )
    })
    .catch((failure: unknown) => {
      void logPermissionFailure(
        api,
        "PermissionAttentionNotificationFailed",
        failure,
      )
    })
}

function stopPermissionNotification(permission: PendingPermission): void {
  if (!permission.notification) return
  if (permission.notification.exitCode !== null) return
  permission.notification.kill()
}

function stopPendingPermission(
  pendingPermissions: Map<PermissionRequestId, PendingPermission>,
  requestId: PermissionRequestId,
): void {
  const permission = pendingPermissions.get(requestId)
  if (!permission) return
  pendingPermissions.delete(requestId)
  permission.abort.abort()
  stopPermissionNotification(permission)
}

function releaseReplyAttempt(permission: PendingPermission): void {
  permission.hasReplied = false
  permission.authorizedActor = undefined
}

async function replyPermission(
  api: TuiPluginApi,
  pendingPermissions: Map<PermissionRequestId, PendingPermission>,
  permission: PendingPermission,
  actor: PermissionAuditActor,
  replyTo: PermissionAuditReply,
  correctionMessage?: string,
): Promise<boolean> {
  if (!isCurrentPermission(pendingPermissions, permission)) return false
  if (permission.hasReplied) return false
  permission.hasReplied = true
  permission.authorizedActor = actor

  let reply: Awaited<ReturnType<typeof api.client.permission.reply>>
  try {
    reply = await api.client.permission.reply({
      requestID: permission.request.id,
      directory: api.state.path.directory,
      reply: replyTo,
      ...(correctionMessage === undefined
        ? {}
        : { message: correctionMessage }),
    })
  } catch (failure) {
    releaseReplyAttempt(permission)
    if (isCurrentPermission(pendingPermissions, permission)) {
      await logPermissionFailure(api, "PermissionReplyFailed", failure)
    }
    return false
  }

  if (!isCurrentPermission(pendingPermissions, permission)) return false
  if ("error" in reply && reply.error) {
    releaseReplyAttempt(permission)
    await logPermissionFailure(api, "PermissionReplyFailed", reply.error)
    return false
  }
  if (reply.data !== true) {
    releaseReplyAttempt(permission)
    await logPermissionFailure(
      api,
      "PermissionReplyFailed",
      "OpenCode did not confirm the permission reply",
    )
    return false
  }

  stopPermissionNotification(permission)
  return true
}

function showLinuxPermissionNotification(
  api: TuiPluginApi,
  pendingPermissions: Map<PermissionRequestId, PendingPermission>,
  permission: PendingPermission,
): void {
  const notification = spawn(
    "notify-send",
    buildPermissionNotificationArguments(
      formatPermissionNotificationMessage(permission.request),
    ),
    { stdio: ["ignore", "pipe", "ignore"] },
  )
  permission.notification = notification
  let selectedAction = ""

  notification.stdout?.setEncoding("utf8")
  notification.stdout?.on("data", (chunk: string) => {
    selectedAction += chunk
  })
  notification.once("error", (failure: Error) => {
    if (!isCurrentPermission(pendingPermissions, permission)) return
    void logPermissionFailure(
      api,
      "PermissionDesktopNotificationFailed",
      failure,
    )
    showAttentionNotification(api, permission)
  })
  notification.once("close", (exitCode) => {
    if (!isCurrentPermission(pendingPermissions, permission)) return
    const action = selectedAction.trim()
    if (action === ALLOW_ACTION) {
      void replyPermission(api, pendingPermissions, permission, "user", "once")
      return
    }
    if (action === ALWAYS_ACTION) {
      void replyPermission(
        api,
        pendingPermissions,
        permission,
        "user",
        "always",
      )
      return
    }
    if (exitCode !== 0) showAttentionNotification(api, permission)
  })
}

function showPermissionNotification(
  api: TuiPluginApi,
  pendingPermissions: Map<PermissionRequestId, PendingPermission>,
  permission: PendingPermission,
): void {
  if (!isCurrentPermission(pendingPermissions, permission)) return
  if (process.platform !== "linux") {
    showAttentionNotification(api, permission)
    return
  }
  showLinuxPermissionNotification(api, pendingPermissions, permission)
}

function logAuditWriteFailure(
  api: TuiPluginApi,
  failure: unknown,
): Promise<void> {
  return logPermissionFailure(api, "PermissionAuditWriteFailed", failure)
}

async function answerOrNotifyPermission(
  api: TuiPluginApi,
  pendingPermissions: Map<PermissionRequestId, PendingPermission>,
  permission: PendingPermission,
  model: OpenRouterModelId,
  state: PermissionAssistantState,
): Promise<void> {
  if (permission.request.permission === DOOM_LOOP_PERMISSION) {
    const interrupted = await replyPermission(
      api,
      pendingPermissions,
      permission,
      "assistant",
      "reject",
      DOOM_LOOP_CORRECTION,
    )
    if (interrupted || !isCurrentPermission(pendingPermissions, permission)) {
      return
    }
    showPermissionNotification(api, pendingPermissions, permission)
    return
  }

  const question = classifierQuestionFor(permission.request)
  if (!question) {
    showPermissionNotification(api, pendingPermissions, permission)
    return
  }

  const credential = readOpenRouterApiKey(process.env.OPENROUTER_API_KEY)
  if (credential.error && !state.authStoreFailureWasLogged) {
    state.authStoreFailureWasLogged = true
    await logPermissionFailure(api, credential.error, credential.error)
  }
  if (!credential.apiKey) {
    if (state.missingCredentialWasLogged) {
      showPermissionNotification(api, pendingPermissions, permission)
      return
    }
    state.missingCredentialWasLogged = true
    await logPermissionFailure(
      api,
      "OpenRouterCredentialMissing",
      "Run opencode auth login or set OPENROUTER_API_KEY",
    )
    showPermissionNotification(api, pendingPermissions, permission)
    return
  }

  let verdict: DecisionVerdict
  try {
    verdict = await requestDecisionVerdict({
      apiKey: credential.apiKey,
      model,
      question,
      patterns: permission.request.patterns,
      signal: permission.abort.signal,
    })
  } catch (failure) {
    if (!isCurrentPermission(pendingPermissions, permission)) return
    await logPermissionFailure(api, "PermissionClassificationFailed", failure)
    showPermissionNotification(api, pendingPermissions, permission)
    return
  }

  if (!isCurrentPermission(pendingPermissions, permission)) return
  const autoAllowed = isSafePermissionProbability(verdict.probability)
  const classificationFailure = auditPermissionClassification({
    request: permission.request,
    projectDirectory: api.state.path.directory,
    model,
    probability: verdict.probability,
    ...(verdict.explanation === undefined
      ? {}
      : { explanation: verdict.explanation }),
    autoAllowed,
  })
  if (classificationFailure) {
    await logAuditWriteFailure(api, classificationFailure)
  }
  if (!autoAllowed) {
    permission.classifierVerdict = verdict
    showPermissionNotification(api, pendingPermissions, permission)
    return
  }

  const config = readPermissionAssistantConfig(api)
  if (!config) return
  const preferredMode = resolveEffectiveAutoAllowReply(
    config,
    permissionAssistantFeature.id,
    DEFAULT_AUTO_ALLOW_REPLY,
  )
  const wasAllowed = await replyPermission(
    api,
    pendingPermissions,
    permission,
    "classifier",
    newAutoAllowReply(permission.request.permission, preferredMode),
  )
  if (wasAllowed || !isCurrentPermission(pendingPermissions, permission)) return
  showPermissionNotification(api, pendingPermissions, permission)
}

function readPermissionAssistantConfig(api: TuiPluginApi) {
  const configRead = readEssentialsConfig()
  if (configRead.error) {
    void logPermissionFailure(
      api,
      "EssentialsConfigReadFailed",
      configRead.error,
    )
    return undefined
  }
  if (!isFeatureEnabled(configRead.config, permissionAssistantFeature.id)) {
    return undefined
  }
  return configRead.config
}

const tui: TuiPlugin = async (api) => {
  const pendingPermissions = new Map<PermissionRequestId, PendingPermission>()
  const state = {
    missingCredentialWasLogged: false,
    authStoreFailureWasLogged: false,
  }

  const stopAsked = api.event.on("permission.asked", (event) => {
    const config = readPermissionAssistantConfig(api)
    if (!config) return
    const request = newPermissionRequest(event.properties)
    if (!request) {
      showAttentionNotification(api, undefined)
      void logPermissionFailure(
        api,
        "PermissionRequestRejected",
        "The pending request did not match the permission contract",
      )
      return
    }
    if (pendingPermissions.has(request.id)) return

    const permission: PendingPermission = {
      request,
      abort: new AbortController(),
      hasReplied: false,
      fallbackWasShown: false,
    }
    pendingPermissions.set(request.id, permission)
    const model = resolveEffectiveModel(
      config,
      permissionAssistantFeature.id,
      DEFAULT_CLASSIFIER_MODEL,
    )
    void answerOrNotifyPermission(
      api,
      pendingPermissions,
      permission,
      model,
      state,
    ).catch((failure: unknown) => {
      if (!isCurrentPermission(pendingPermissions, permission)) return
      void logPermissionFailure(api, "PermissionAssistantFailed", failure)
      showPermissionNotification(api, pendingPermissions, permission)
    })
  })

  const stopReplied = api.event.on("permission.replied", (event) => {
    const requestId = newPermissionRequestId(event.properties.requestID)
    if (!requestId) return
    const permission = pendingPermissions.get(requestId)
    if (permission) {
      const decisionFailure = auditPermissionDecision({
        request: permission.request,
        projectDirectory: api.state.path.directory,
        actor: permission.authorizedActor ?? "user",
        reply: event.properties.reply,
        ...(permission.classifierVerdict === undefined
          ? {}
          : { classifierVerdict: permission.classifierVerdict }),
      })
      if (decisionFailure) {
        void logAuditWriteFailure(api, decisionFailure)
      }
    }
    stopPendingPermission(pendingPermissions, requestId)
  })

  api.lifecycle.onDispose(() => {
    stopAsked()
    stopReplied()
    for (const requestId of pendingPermissions.keys()) {
      stopPendingPermission(pendingPermissions, requestId)
    }
  })
}

export default {
  id: "opencode-essentials-permission-assistant",
  tui,
} satisfies TuiPluginModule
