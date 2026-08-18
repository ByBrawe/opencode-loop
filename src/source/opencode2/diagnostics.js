import { readState as defaultReadState, stateDir } from "../core/state.js"

export const OPENCODE_LOOP_V2_HELP_TEXT = [
  "OpenCode Loop V2 experimental help:",
  "/loop 0s --max-runs 2 <prompt>                  autonomous prompt loop",
  "/loop 5m --no-now --name later --multi <prompt> delayed named prompt loop",
  "/loop 0s --command /review                       slash-command loop when the host exposes session.command",
  "/loop-status                                      show current Loop jobs",
  "/loop-now [target]                                run matching jobs on the next idle boundary",
  "/loop-pause [target] | /loop-resume [target]      pause or resume jobs",
  "/loop-stop [target] | /loop-remove [target]       remove matching jobs",
  "/loop-clear                                       clear all jobs",
  "/loop-export                                      export current session Loop state as JSON",
  "/loop-help                                        show this experimental V2 help",
  "/loop-doctor                                      show local V2 diagnostics",
  "Experimental V2 does not yet claim full stable-plugin parity; unsupported options fail closed.",
].join("\n")

function scopeFrom(event) {
  const directory = typeof event?.directory === "string" ? event.directory.trim() : ""
  const sessionID = String(event?.sessionID || "").trim()
  if (!directory || !sessionID) return undefined
  return { directory, sessionID }
}

export function createOpenCode2DiagnosticsRuntime(options = {}) {
  if (typeof options.prompt !== "function") throw new TypeError("V2 diagnostics runtime requires prompt()")
  const readState = typeof options.readState === "function" ? options.readState : defaultReadState
  const runtimeVersion = options.runtimeVersion || process.version
  const runtimePlatform = options.runtimePlatform || process.platform

  async function exportState(event) {
    const scope = scopeFrom(event)
    if (!scope) return { handled: false, reason: "missing-scope" }
    const state = await readState(scope.directory, scope.sessionID)
    const text = `OpenCode loop state export:\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``
    const request = { sessionID: scope.sessionID, text, noReply: true }
    await options.prompt(request)
    return { handled: true, accepted: true, state, request }
  }

  async function help(event) {
    const scope = scopeFrom(event)
    if (!scope) return { handled: false, reason: "missing-scope" }
    const request = { sessionID: scope.sessionID, text: OPENCODE_LOOP_V2_HELP_TEXT, noReply: true }
    await options.prompt(request)
    return { handled: true, accepted: true, request }
  }

  async function doctor(event) {
    const scope = scopeFrom(event)
    if (!scope) return { handled: false, reason: "missing-scope" }
    const state = await readState(scope.directory, scope.sessionID)
    const text = [
      "OpenCode Loop V2 doctor:",
      "- plugin: bybrawe.opencode-loop.v2.experimental",
      `- project directory: ${scope.directory}`,
      `- state directory: ${stateDir(scope.directory)}`,
      `- active jobs: ${(state.jobs || []).length}`,
      `- node: ${runtimeVersion}`,
      `- platform: ${runtimePlatform}`,
      "- full stable parity: not claimed",
      "- smoke test: /loop 0s --max-runs 1 continue the current task",
    ].join("\n")
    const request = { sessionID: scope.sessionID, text, noReply: true }
    await options.prompt(request)
    return { handled: true, accepted: true, state, request }
  }

  async function onEvent(event) {
    if (event?.kind === "command" && event?.action === "executed") {
      if (event?.name === "loop-export") return await exportState(event)
      if (event?.name === "loop-help") return await help(event)
      if (event?.name === "loop-doctor") return await doctor(event)
    }
    return { handled: false }
  }

  return Object.freeze({ onEvent, exportState, help, doctor })
}
