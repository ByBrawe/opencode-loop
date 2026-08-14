import { presetDefaults } from "../core/jobs.js"
import { captureSessionExecutionContext as defaultCaptureSessionExecutionContext } from "./session-context.js"
import { guardLoopOwnedUserMessage as defaultGuardLoopOwnedUserMessage } from "./messages.js"
import {
  markHandled,
  consumeHandled,
  hasHandledCommandEvent,
  markHandledCommandEvent,
  forgetHandledCommandEvent,
  commandName,
  isPreset,
  isLoopCommandName,
  commandArgsText,
} from "./commands.js"

const HANDLER_NAMES = [
  "addGoal",
  "statusGoal",
  "pauseGoal",
  "resumeGoal",
  "clearGoal",
  "completeGoalCommand",
  "blockGoalCommand",
  "addLoop",
  "stopLoop",
  "statusLoop",
  "logsLoop",
  "helpLoop",
  "runNow",
  "updateJobState",
  "doctorLoop",
  "initLoop",
  "exportLoop",
]

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`createCommandRouter requires ${name}`)
  return value
}

export function createCommandRouter(options = {}) {
  const rememberSession = requireFunction(options.rememberSession, "rememberSession")
  const captureSessionExecutionContext = typeof options.captureSessionExecutionContext === "function"
    ? options.captureSessionExecutionContext
    : defaultCaptureSessionExecutionContext
  const guardLoopOwnedUserMessage = typeof options.guardLoopOwnedUserMessage === "function"
    ? options.guardLoopOwnedUserMessage
    : defaultGuardLoopOwnedUserMessage
  const handlers = {}
  for (const name of HANDLER_NAMES) handlers[name] = requireFunction(options.handlers?.[name], `handlers.${name}`)

  return async function handleCommand(directory, client, input, fallbackName, fallbackArgs, output, source = "before") {
    const name = commandName(input?.command ?? input?.name ?? fallbackName)
    const sessionID = input?.sessionID
    const args = commandArgsText(input?.arguments ?? fallbackArgs ?? "")
    if (!sessionID || !name) return false
    rememberSession(directory, client, sessionID)
    if (isLoopCommandName(name)) await captureSessionExecutionContext(client, sessionID)
    if (source === "event") {
      if (consumeHandled(sessionID, name, args)) return true
      if (hasHandledCommandEvent(sessionID, input?.messageID)) return true
      markHandledCommandEvent(sessionID, input?.messageID)
    } else {
      // Every before-hook invocation is an intentional command. Keep a pending
      // count only so the matching command.executed compatibility event can be
      // consumed without suppressing a genuine repeated command.
      markHandled(sessionID, name, args)
    }
    if (isLoopCommandName(name)) guardLoopOwnedUserMessage(sessionID)

    const handled = () => {
      // OpenCode 1.18.x ignores unknown hook output fields, while proposed/newer
      // hosts can honor noReply to skip the otherwise unavoidable model turn.
      // Keep acknowledgement parts intact as the compatibility fallback.
      if (output && typeof output === "object") output.noReply = true
      return true
    }

    if (name === "loop-goal") return await handlers.addGoal(directory, client, sessionID, args), handled()
    if (name === "loop-goal-status") return await handlers.statusGoal(directory, client, sessionID), handled()
    if (name === "loop-goal-pause") return await handlers.pauseGoal(directory, client, sessionID, args), handled()
    if (name === "loop-goal-resume") return await handlers.resumeGoal(directory, client, sessionID, args), handled()
    if (name === "loop-goal-clear") return await handlers.clearGoal(directory, client, sessionID, args), handled()
    if (name === "loop-goal-done" || name === "loop-goal-complete") return await handlers.completeGoalCommand(directory, client, sessionID, args), handled()
    if (name === "loop-goal-blocked") return await handlers.blockGoalCommand(directory, client, sessionID, args), handled()
    if (name === "loop") return await handlers.addLoop(directory, client, sessionID, args), handled()
    if (isPreset(name)) return await handlers.addLoop(directory, client, sessionID, args, presetDefaults(name, args)), handled()
    if (name === "loop-stop" || name === "loop-remove") return await handlers.stopLoop(directory, client, sessionID, args), handled()
    if (name === "loop-clear") return await handlers.stopLoop(directory, client, sessionID, "all"), handled()
    if (name === "loop-status") return await handlers.statusLoop(directory, client, sessionID), handled()
    if (name === "loop-logs") return await handlers.logsLoop(directory, client, sessionID), handled()
    if (name === "loop-help") return await handlers.helpLoop(client, sessionID), handled()
    if (name === "loop-now") return await handlers.runNow(directory, client, sessionID, args), handled()
    if (name === "loop-pause") return await handlers.updateJobState(directory, client, sessionID, args, (job) => ({ ...job, paused: true }), "Paused"), handled()
    if (name === "loop-resume") return await handlers.updateJobState(directory, client, sessionID, args, (job) => ({ ...job, paused: false, lastRunAt: 0 }), "Resumed"), handled()
    if (name === "loop-doctor") return await handlers.doctorLoop(directory, client, sessionID), handled()
    if (name === "loop-init") return await handlers.initLoop(directory, client, sessionID, args), handled()
    if (name === "loop-export") return await handlers.exportLoop(directory, client, sessionID), handled()
    if (source === "event") forgetHandledCommandEvent(sessionID, input?.messageID)
    else consumeHandled(sessionID, name, args)
    return false
  }
}
