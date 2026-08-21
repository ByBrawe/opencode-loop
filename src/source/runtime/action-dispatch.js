import { splitFirst } from "../core/args.js"
import { actionKind } from "../core/jobs.js"
import { appendLoopLog as defaultAppendLoopLog } from "../core/process.js"
import { sdkCall as defaultSdkCall } from "../opencode/sdk.js"
import { normalizedModelRef as defaultNormalizedModelRef } from "../opencode/session-context.js"
import { fireSdk as defaultFireSdk, compactTuiCommandName as defaultCompactTuiCommandName, toast as defaultToast } from "../opencode/host.js"
import { guardLoopOwnedUserMessage as defaultGuardLoopOwnedUserMessage } from "../opencode/messages.js"
import { dangerousShell as defaultDangerousShell } from "./job-workspace.js"

function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`createActionDispatcher requires ${label}`)
  return value
}

export function createActionDispatcher(options = {}) {
  const buildPrompt = requireFunction(options.buildPrompt, "buildPrompt")
  const startCompaction = requireFunction(options.compactionRuntime?.start, "compactionRuntime.start")
  const appendLoopLog = typeof options.appendLoopLog === "function" ? options.appendLoopLog : defaultAppendLoopLog
  const sdkCall = typeof options.sdkCall === "function" ? options.sdkCall : defaultSdkCall
  const normalizedModelRef = typeof options.normalizedModelRef === "function" ? options.normalizedModelRef : defaultNormalizedModelRef
  const fireSdk = typeof options.fireSdk === "function" ? options.fireSdk : defaultFireSdk
  const compactTuiCommandName = typeof options.compactTuiCommandName === "function"
    ? options.compactTuiCommandName
    : defaultCompactTuiCommandName
  const toast = typeof options.toast === "function" ? options.toast : defaultToast
  const guardLoopOwnedUserMessage = typeof options.guardLoopOwnedUserMessage === "function"
    ? options.guardLoopOwnedUserMessage
    : defaultGuardLoopOwnedUserMessage
  const dangerousShell = typeof options.dangerousShell === "function" ? options.dangerousShell : defaultDangerousShell

  async function fireAction(directory, client, sessionID, job) {
    const action = String(job.action || "").trim()
    const kind = actionKind(action, job)
    const agent = job.agent || "build"
    const model = normalizedModelRef(job.model)

    if (kind === "compact") {
      const ok = await startCompaction(directory, client, sessionID, job.id, model, false)
      return { startsAssistantTurn: ok, pause: !ok, reason: "compact_failed", compaction: ok }
    }

    if (kind === "command") {
      const normalized = action.startsWith("/") ? action.slice(1) : action
      const [command, argumentsText] = splitFirst(normalized)
      if (!command) {
        await toast(client, "Loop command action is empty. Example: /loop-command 200m /compact", "warning")
        return { startsAssistantTurn: false, pause: true, reason: "empty_command" }
      }
      const tuiCommand = compactTuiCommandName(command)
      if (tuiCommand) {
        guardLoopOwnedUserMessage(sessionID)
        const ok = await startCompaction(directory, client, sessionID, job.id, model, false)
        return { startsAssistantTurn: ok, pause: !ok, reason: "compact_failed", compaction: ok }
      }
      guardLoopOwnedUserMessage(sessionID)
      const commandBody = { command, arguments: argumentsText, agent }
      if (model) commandBody.model = `${model.providerID}/${model.modelID}`
      await sdkCall(
        client.session.command.bind(client.session),
        { path: { id: sessionID }, body: commandBody },
        { path: { sessionID }, body: commandBody },
        { sessionID, ...commandBody },
      )
      return { startsAssistantTurn: true }
    }

    if (kind === "shell") {
      const command = action.replace(/^[!$]\s*/, "").trim()
      if (job.safe && dangerousShell(command)) {
        await toast(client, `Blocked dangerous shell command in safe mode: ${command}`, "error")
        await appendLoopLog(directory, "blocked", { sessionID, job: job.name || job.id, command })
        return { startsAssistantTurn: false, pause: true, reason: "safe_shell_blocked" }
      }
      guardLoopOwnedUserMessage(sessionID)
      const shellBody = { command, agent }
      if (model) shellBody.model = model
      const dispatch = fireSdk(
        client,
        "session.shell",
        client.session.shell.bind(client.session),
        { path: { id: sessionID }, body: shellBody },
        { path: { sessionID }, body: shellBody },
        { sessionID, ...shellBody },
      )
      return { startsAssistantTurn: true, dispatch }
    }

    const prompt = await buildPrompt(directory, job)
    const prefix = kind === "goal"
      ? "EXPERIMENTAL GOAL MODE CONTINUATION. Continue pursuing the active goal. Do not explain the /loop-goal command. Use the goal tools only when progress/completion/block state is real."
      : "AUTONOMOUS OPENCODE LOOP ITERATION. Continue the configured task now. Do not explain the /loop command. Do not search for documentation about this plugin. Do not create scheduler files. Do not ask questions. Make reasonable assumptions and work directly."
    const promptText = `${prefix}\n\n${prompt}`
    guardLoopOwnedUserMessage(sessionID)
    const promptBody = { agent, parts: [{ type: "text", text: promptText }] }
    if (model) promptBody.model = model
    const dispatch = fireSdk(
      client,
      "session.prompt",
      client.session.prompt.bind(client.session),
      { path: { id: sessionID }, body: promptBody },
      { path: { sessionID }, body: promptBody },
      { sessionID, ...promptBody },
    )
    return { startsAssistantTurn: true, dispatch }
  }

  return { fireAction }
}
