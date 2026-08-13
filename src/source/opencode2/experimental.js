import { define } from "@opencode-ai/plugin/v2/promise"
import { createSessionRuntimeManager } from "../runtime/session-manager.js"

export const V2_PLUGIN_ID = "bybrawe.opencode-loop.v2.experimental"

export const V2_AUTONOMOUS_REQUIREMENTS = Object.freeze([
  "sessionGet",
  "sessionPrompt",
  "sessionHook",
  "sessionWait",
  "eventSubscribe",
  "toolHook",
])

export function detectV2Capabilities(ctx) {
  return Object.freeze({
    pluginList: typeof ctx?.plugin?.list === "function",
    commandTransform: typeof ctx?.command?.transform === "function",
    sessionGet: typeof ctx?.session?.get === "function",
    sessionPrompt: typeof ctx?.session?.prompt === "function",
    sessionHook: typeof ctx?.session?.hook === "function",
    sessionWait: typeof ctx?.session?.wait === "function",
    sessionInterrupt: typeof ctx?.session?.interrupt === "function",
    eventSubscribe: typeof ctx?.event?.subscribe === "function",
    toolHook: typeof ctx?.tool?.hook === "function",
    toolTransform: typeof ctx?.tool?.transform === "function",
  })
}

export function missingLoopV2Capabilities(capabilities) {
  return V2_AUTONOMOUS_REQUIREMENTS.filter((name) => capabilities?.[name] !== true)
}

export function inspectLoopV2Readiness(ctx) {
  const capabilities = detectV2Capabilities(ctx)
  const missing = missingLoopV2Capabilities(capabilities)
  return Object.freeze({
    capabilities,
    missing: Object.freeze(missing),
    autonomousReady: missing.length === 0,
  })
}

function sessionIDFromObservation(value) {
  return String(
    value?.sessionID
      || value?.session?.id
      || value?.session?.sessionID
      || value?.properties?.sessionID
      || value?.properties?.session?.id
      || "",
  ).trim()
}

export function createV2AdapterRuntime(options = {}) {
  const manager = options.manager || createSessionRuntimeManager(options.runtime)

  return Object.freeze({
    observe(value) {
      const sessionID = sessionIDFromObservation(value)
      if (!sessionID) return undefined
      return manager.observeExternal(sessionID)
    },
    peek: (sessionID) => manager.peek(sessionID),
    entries: () => manager.entries(),
    pruneStale: (at) => manager.pruneStale(at),
    dispose: (reason) => manager.dispose(reason),
  })
}

export const OpenCodeLoopV2Experimental = define({
  id: V2_PLUGIN_ID,
  setup: async (ctx) => {
    // The published V2 Promise package currently exposes the transform/plugin
    // domains but its typed context has not yet caught up with the documented
    // session/event/tool runtime surface. Keep activation side-effect free until
    // all capabilities needed by the autonomous scheduler are present.
    inspectLoopV2Readiness(ctx)
  },
})

export default OpenCodeLoopV2Experimental
