import { define } from "@opencode-ai/plugin/v2/promise"
import { createSessionRuntimeManager } from "../runtime/session-manager.js"

export const V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export function detectV2Capabilities(ctx) {
  return Object.freeze({
    commandTransform: typeof ctx?.command?.transform === "function",
    sessionPrompt: typeof ctx?.session?.prompt === "function",
    sessionHook: typeof ctx?.session?.hook === "function",
    sessionWait: typeof ctx?.session?.wait === "function",
    eventSubscribe: typeof ctx?.event?.subscribe === "function",
    toolTransform: typeof ctx?.tool?.transform === "function",
  })
}

export function missingLoopV2Capabilities(capabilities) {
  const required = ["commandTransform", "sessionPrompt", "sessionHook", "sessionWait"]
  return required.filter((name) => capabilities?.[name] !== true)
}

function sessionIDFromEvent(event) {
  return String(event?.sessionID || event?.session?.id || event?.session?.sessionID || "").trim()
}

export function createV2AdapterRuntime(options = {}) {
  const manager = options.manager || createSessionRuntimeManager(options.runtime)

  function observe(event) {
    const sessionID = sessionIDFromEvent(event)
    if (!sessionID) return undefined
    return manager.observeExternal(sessionID)
  }

  return Object.freeze({
    observe,
    peek: (sessionID) => manager.peek(sessionID),
    entries: () => manager.entries(),
    pruneStale: (at) => manager.pruneStale(at),
    dispose: (reason) => manager.dispose(reason),
  })
}

async function registerStatusCommand(ctx, capabilities) {
  if (!capabilities.commandTransform) return
  const missing = missingLoopV2Capabilities(capabilities)
  const summary = Object.entries(capabilities)
    .map(([name, available]) => `${name}=${available ? "yes" : "no"}`)
    .join(", ")

  await ctx.command.transform((commands) => {
    commands.update("loop-v2-status", (command) => {
      command.description = "Report the experimental OpenCode Loop V2 adapter status."
      command.template = [
        "OpenCode Loop V2 experimental adapter is active.",
        `Capabilities: ${summary}.`,
        missing.length
          ? `Autonomous Loop V2 is still gated on: ${missing.join(", ")}.`
          : "The host exposes the capabilities required for the next autonomous Loop V2 slice.",
      ].join("\n")
    })
  })
}

export const OpenCodeLoopV2Experimental = define({
  id: V2_PLUGIN_ID,
  setup: async (ctx) => {
    const capabilities = detectV2Capabilities(ctx)
    const runtime = createV2AdapterRuntime()

    await registerStatusCommand(ctx, capabilities)

    if (capabilities.sessionHook) {
      await ctx.session.hook("context", (event) => {
        runtime.observe(event)
      })
    }

    return () => {
      runtime.dispose("plugin-unload")
    }
  },
})

export default OpenCodeLoopV2Experimental
