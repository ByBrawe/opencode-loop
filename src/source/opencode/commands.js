import { now } from "../core/args.js"

const COMMAND_DEDUPE_MS = 30_000
const handledCommands = new Map()
const handledCommandEvents = new Map()

function normalizeArgsForKey(args) {
  if (args === undefined || args === null) return ""
  if (typeof args === "string") return args.trim().replace(/\s+/g, " ")
  if (Array.isArray(args)) return args.map(normalizeArgsForKey).join(" ").trim().replace(/\s+/g, " ")
  try { return JSON.stringify(args) } catch { return String(args) }
}

function commandKey(sessionID, name, args) {
  return `${sessionID || "no-session"}:${name || ""}:${normalizeArgsForKey(args)}`
}

function commandEventKey(sessionID, messageID) {
  return `${sessionID || "no-session"}:event:${messageID || "no-message"}`
}

export function markHandled(sessionID, name, args) {
  const key = commandKey(sessionID, name, args)
  const previous = handledCommands.get(key)
  const pending = previous && now() - previous.time < COMMAND_DEDUPE_MS ? previous.pending + 1 : 1
  handledCommands.set(key, { time: now(), pending })
  for (const [entryKey, entry] of handledCommands.entries()) if (now() - entry.time > COMMAND_DEDUPE_MS) handledCommands.delete(entryKey)
  for (const [entryKey, time] of handledCommandEvents.entries()) if (now() - time > COMMAND_DEDUPE_MS) handledCommandEvents.delete(entryKey)
}

export function consumeHandled(sessionID, name, args) {
  const key = commandKey(sessionID, name, args)
  const entry = handledCommands.get(key)
  if (!entry || now() - entry.time >= COMMAND_DEDUPE_MS) {
    handledCommands.delete(key)
    return false
  }
  if (entry.pending <= 1) handledCommands.delete(key)
  else handledCommands.set(key, { time: entry.time, pending: entry.pending - 1 })
  return true
}

export function hasHandledCommandEvent(sessionID, messageID) {
  return handledCommandEvents.has(commandEventKey(sessionID, messageID))
}

export function markHandledCommandEvent(sessionID, messageID) {
  handledCommandEvents.set(commandEventKey(sessionID, messageID), now())
}

export function forgetHandledCommandEvent(sessionID, messageID) {
  handledCommandEvents.delete(commandEventKey(sessionID, messageID))
}

export function clearCommandLifecycle(sessionID) {
  const prefix = `${sessionID}:`
  for (const key of handledCommands.keys()) if (key.startsWith(prefix)) handledCommands.delete(key)
  for (const key of handledCommandEvents.keys()) if (key.startsWith(prefix)) handledCommandEvents.delete(key)
}

export function commandName(name) {
  return String(name || "")
}

export function isPreset(name) {
  return ["loop-dev", "loop-testfix", "loop-compact", "loop-progress", "loop-safe-dev", "loop-command", "loop-cmd", "loop-prompt", "loop-ask", "loop-shell"].includes(name)
}

export function isLoopCommandName(name) {
  return name === "loop" || name === "loop-stop" || name === "loop-remove" || name === "loop-clear" || name === "loop-status" || name === "loop-logs" || name === "loop-help" || name === "loop-now" || name === "loop-pause" || name === "loop-resume" || name === "loop-doctor" || name === "loop-init" || name === "loop-export" || name === "loop-goal" || name === "loop-goal-status" || name === "loop-goal-pause" || name === "loop-goal-resume" || name === "loop-goal-clear" || name === "loop-goal-done" || name === "loop-goal-complete" || name === "loop-goal-blocked" || isPreset(name)
}

export function commandArgsText(args) {
  if (args === undefined || args === null) return ""
  if (typeof args === "string") return args
  if (Array.isArray(args)) return args.map(commandArgsText).join(" ")
  if (typeof args === "object") {
    for (const key of ["arguments", "args", "message", "text", "value"]) {
      if (args[key] !== undefined) return commandArgsText(args[key])
    }
  }
  return String(args)
}
