import type { Hooks } from "@opencode-ai/plugin"

export function combineHooks(hooksList: Hooks[]): Hooks {
  const eventHandlers = hooksList.flatMap((hooks) =>
    hooks.event ? [hooks.event] : [],
  )
  const messageHandlers = hooksList.flatMap((hooks) =>
    hooks["chat.message"] ? [hooks["chat.message"]] : [],
  )
  const disposers = hooksList.flatMap((hooks) =>
    hooks.dispose ? [hooks.dispose] : [],
  )

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
