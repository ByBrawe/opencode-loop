import { parseLoopArgs } from "../core/args.js"
import { actionKind, presetDefaults } from "../core/jobs.js"

function scopeFrom(event) {
  const directory = typeof event?.directory === "string" ? event.directory.trim() : ""
  const sessionID = String(event?.sessionID || "").trim()
  if (!directory || !sessionID) return undefined
  return { directory, sessionID }
}

function shellRequest(event) {
  if (event?.kind !== "command" || event?.action !== "executed") return false
  if (event?.name === "loop-shell") return true
  if (event?.name !== "loop") return false
  const parsed = parseLoopArgs(event.arguments || "")
  return Boolean(parsed.ok && actionKind(parsed.job?.action, parsed.job) === "shell")
}

function shellCommandText(event) {
  if (event?.name !== "loop-shell") return undefined
  const parsed = parseLoopArgs(event.arguments || "", presetDefaults("loop-shell"))
  if (!parsed.ok) return undefined
  return String(parsed.job?.action || "").trim() || undefined
}

export function createOpenCode2ShellBoundary(options = {}) {
  if (typeof options.prompt !== "function") throw new TypeError("V2 shell boundary requires prompt()")
  const capabilities = options.capabilities || {}

  async function onEvent(event) {
    if (!shellRequest(event)) return { handled: false }
    const scope = scopeFrom(event)
    if (!scope) return { handled: false, reason: "missing-scope" }

    const hostExposesShell = capabilities.sessionShell === true
    const blocker = hostExposesShell ? "shell-runtime" : "shell-capability"
    const command = shellCommandText(event)
    const detail = hostExposesShell
      ? "This OpenCode 2 host exposes session.shell, but Loop V2 native shell scheduling remains disabled until current-agent/model inheritance is proven end-to-end. No shell command was executed."
      : "This OpenCode 2 plugin host does not expose session.shell. The server may have a shell HTTP endpoint, but Loop will not bypass the plugin capability contract. No shell command was executed."
    const text = [
      "OpenCode Loop V2 shell scheduling is unavailable.",
      `- blocker: ${blocker}`,
      `- session.shell: ${hostExposesShell ? "available" : "missing from plugin context"}`,
      command ? `- requested command: ${command}` : undefined,
      `- safety: ${detail}`,
      "Use stable OpenCode 1.x /loop-shell for shell scheduling, or wait for the experimental V2 host/runtime boundary to become available.",
    ].filter(Boolean).join("\n")
    const request = { sessionID: scope.sessionID, text, noReply: true }
    await options.prompt(request)
    return { handled: true, accepted: false, reason: "unsupported", blockers: [blocker], request }
  }

  return Object.freeze({ onEvent })
}
