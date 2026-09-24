import { type ChildProcess, spawn } from "node:child_process"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { buildPermissionNotificationArguments } from "./features/notificationText.ts"
import { permissionAssistantFeature } from "./features/permission-assistant.ts"
import {
  DEFAULT_CLASSIFIER_MODEL,
  isSafePermissionProbability,
  requestSafePermissionProbability,
} from "./features/permissionDecision.ts"
import { sanitizeText } from "./log.ts"
import { readOpenRouterApiKey } from "./openRouterAuth.ts"
import {
  isFeatureEnabled,
  readEssentialsConfig,
  resolveEffectiveModel,
} from "./state.ts"
import type { OpenRouterModelId } from "./valueObject/openRouterModelId.ts"
import type { PermissionRequest } from "./valueObject/permissionRequest.ts"
import { newPermissionRequest } from "./valueObject/permissionRequest.ts"
import type { PermissionRequestId } from "./valueObject/permissionRequestId.ts"
import { newPermissionRequestId } from "./valueObject/permissionRequestId.ts"

const MAX_CLASSIFIER_COMMANDS = 8
const MAX_CLASSIFIER_COMMAND_CHARS = 2_000
const ALLOW_ACTION = "allow"

type PendingPermission = {
  request: PermissionRequest
  abort: AbortController
  notification?: ChildProcess
  hasReplied: boolean
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

function shouldClassifyBashPermission(request: PermissionRequest): boolean {
  if (request.permission !== "bash") return false
  if (request.patterns.length === 0) return false
  if (request.patterns.length > MAX_CLASSIFIER_COMMANDS) return false
  return request.patterns.every(
    (pattern) => pattern.length <= MAX_CLASSIFIER_COMMAND_CHARS,
  )
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

async function replyPermissionOnce(
  api: TuiPluginApi,
  pendingPermissions: Map<PermissionRequestId, PendingPermission>,
  permission: PendingPermission,
): Promise<boolean> {
  if (!isCurrentPermission(pendingPermissions, permission)) return false
  if (permission.hasReplied) return false
  permission.hasReplied = true

  let reply: Awaited<ReturnType<typeof api.client.permission.reply>>
  try {
    reply = await api.client.permission.reply({
      requestID: permission.request.id,
      directory: api.state.path.directory,
      reply: "once",
    })
  } catch (failure) {
    permission.hasReplied = false
    if (isCurrentPermission(pendingPermissions, permission)) {
      await logPermissionFailure(api, "PermissionReplyFailed", failure)
    }
    return false
  }

  if (!isCurrentPermission(pendingPermissions, permission)) return false
  if ("error" in reply && reply.error) {
    permission.hasReplied = false
    await logPermissionFailure(api, "PermissionReplyFailed", reply.error)
    return false
  }
  if (reply.data !== true) {
    permission.hasReplied = false
    await logPermissionFailure(
      api,
      "PermissionReplyFailed",
      "OpenCode did not confirm the permission reply",
    )
    return false
  }

  stopPendingPermission(pendingPermissions, permission.request.id)
  return true
}

function showLinuxPermissionNotification(
  api: TuiPluginApi,
  pendingPermissions: Map<PermissionRequestId, PendingPermission>,
  permission: PendingPermission,
): void {
  if (!canShowPermissionNotification(api)) return

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
    if (selectedAction.trim() === ALLOW_ACTION) {
      void replyPermissionOnce(api, pendingPermissions, permission)
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

async function classifyOrNotifyPermission(
  api: TuiPluginApi,
  pendingPermissions: Map<PermissionRequestId, PendingPermission>,
  permission: PendingPermission,
  model: OpenRouterModelId,
  state: PermissionAssistantState,
): Promise<void> {
  if (!shouldClassifyBashPermission(permission.request)) {
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

  let probability: number
  try {
    probability = await requestSafePermissionProbability({
      apiKey: credential.apiKey,
      model,
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
  if (!isSafePermissionProbability(probability)) {
    showPermissionNotification(api, pendingPermissions, permission)
    return
  }

  if (!readPermissionAssistantConfig(api)) return
  const wasAllowed = await replyPermissionOnce(
    api,
    pendingPermissions,
    permission,
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
    void classifyOrNotifyPermission(
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
