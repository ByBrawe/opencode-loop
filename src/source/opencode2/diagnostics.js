import { readState as defaultReadState } from "../core/state.js"

function scopeFrom(event) {
  const directory = typeof event?.directory === "string" ? event.directory.trim() : ""
  const sessionID = String(event?.sessionID || "").trim()
  if (!directory || !sessionID) return undefined
  return { directory, sessionID }
}

export function createOpenCode2DiagnosticsRuntime(options = {}) {
  if (typeof options.prompt !== "function") throw new TypeError("V2 diagnostics runtime requires prompt()")
  const readState = typeof options.readState === "function" ? options.readState : defaultReadState

  async function exportState(event) {
    const scope = scopeFrom(event)
    if (!scope) return { handled: false, reason: "missing-scope" }
    const state = await readState(scope.directory, scope.sessionID)
    const text = `OpenCode loop state export:\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``
    const request = { sessionID: scope.sessionID, text, noReply: true }
    await options.prompt(request)
    return { handled: true, accepted: true, state, request }
  }

  async function onEvent(event) {
    if (event?.kind === "command" && event?.action === "executed" && event?.name === "loop-export") {
      return await exportState(event)
    }
    return { handled: false }
  }

  return Object.freeze({ onEvent, exportState })
}
