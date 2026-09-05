import type { Hooks } from "@opencode-ai/plugin"

type HookName = "event" | "chat.message" | "dispose"

function handlersFor<Name extends HookName>(
  hooksList: Hooks[],
  name: Name,
): NonNullable<Hooks[Name]>[] {
  const handlers: NonNullable<Hooks[Name]>[] = []
  for (const hookSet of hooksList) {
    const handler = hookSet[name]
    if (handler) handlers.push(handler)
  }
  return handlers
}

export function combineHooks(hooksList: Hooks[]): Hooks {
  const eventHandlers = handlersFor(hooksList, "event")
  const messageHandlers = handlersFor(hooksList, "chat.message")
  const disposers = handlersFor(hooksList, "dispose")

  return {
    event: async (input) => {
      for (const handler of eventHandlers) await handler(input)
    },
    "chat.message": async (input, output) => {
      for (const handler of messageHandlers) await handler(input, output)
    },
    dispose: async () => {
      for (const dispose of disposers) await dispose()
    },
  }
}
