import { promises as fs } from "node:fs"
import path from "node:path"
import { readState as defaultReadState, stateDir } from "../core/state.js"

export const OPENCODE_LOOP_V2_HELP_TEXT = [
  "OpenCode Loop V2 experimental help:",
  "/loop 0s --max-runs 2 <prompt>                  autonomous prompt loop",
  "/loop 5m --no-now --name later --multi <prompt> delayed named prompt loop",
  "/loop 0s --command /review                       slash-command loop when the host exposes session.command",
  "/loop-shell <interval> <command>                  registered fail-closed boundary; requires native session.shell support",
  "/loop-status                                      show current Loop jobs",
  "/loop-now [target]                                run matching jobs on the next idle boundary",
  "/loop-pause [target] | /loop-resume [target]      pause or resume jobs",
  "/loop-stop [target] | /loop-remove [target]       remove matching jobs",
  "/loop-clear                                       clear all jobs",
  "/loop-export                                      export current session Loop state as JSON",
  "/loop-logs                                        show the latest V2 runtime events",
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

function capabilityLine(name, available, missing) {
  return `- ${name}: ${available ? "available" : missing}`
}

export function createOpenCode2DiagnosticsRuntime(options = {}) {
  if (typeof options.prompt !== "function") throw new TypeError("V2 diagnostics runtime requires prompt()")
  const readState = typeof options.readState === "function" ? options.readState : defaultReadState
  const readFile = typeof options.readFile === "function" ? options.readFile : (...args) => fs.readFile(...args)
  const runtimeVersion = options.runtimeVersion || process.version
  const runtimePlatform = options.runtimePlatform || process.platform
  const capabilities = options.capabilities || {}

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
      capabilityLine("prompt runtime", capabilities.sessionPrompt === true, "host-blocked (session.prompt missing)"),
      capabilityLine("slash-command dispatch", capabilities.sessionCommand === true, "host-blocked (session.command missing)"),
      capabilityLine("shell dispatch", capabilities.sessionShell === true, "host-blocked (session.shell missing from plugin context)"),
      "- shell scheduling: fail-closed until native plugin capability plus safe current-agent/model inheritance are proven",
      "- full stable parity: not claimed",
      "- smoke test: /loop 0s --max-runs 1 continue the current task",
    ].join("\n")
    const request = { sessionID: scope.sessionID, text, noReply: true }
    await options.prompt(request)
    return { handled: true, accepted: true, state, request }
  }

  async function logs(event) {
    const scope = scopeFrom(event)
    if (!scope) return { handled: false, reason: "missing-scope" }
    let text = "No OpenCode 2 Loop log found."
    try {
      const raw = await readFile(path.join(stateDir(scope.directory), "loop.log"), "utf8")
      const lines = String(raw || "")
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.includes('"v2":true'))
        .slice(-80)
      if (lines.length) text = lines.join("\n")
    } catch {}
    const request = { sessionID: scope.sessionID, text: `OpenCode Loop V2 logs:\n${text}`, noReply: true }
    await options.prompt(request)
    return { handled: true, accepted: true, request }
  }

  async function onEvent(event) {
    if (event?.kind === "command" && event?.action === "executed") {
      if (event?.name === "loop-export") return await exportState(event)
      if (event?.name === "loop-help") return await help(event)
      if (event?.name === "loop-doctor") return await doctor(event)
      if (event?.name === "loop-logs") return await logs(event)
    }
    return { handled: false }
  }

  return Object.freeze({ onEvent, exportState, help, doctor, logs })
}
