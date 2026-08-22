import { parseLoopArgs as defaultParseLoopArgs } from "../core/args.js"
import { actionKind, jobLabel, isGoalJob } from "../core/jobs.js"
import { normalizeLoopScheduleArgs as defaultNormalizeLoopScheduleArgs } from "../core/schedule-syntax.js"
import { readState as defaultReadState, writeState as defaultWriteState } from "../core/state.js"
import { appendLoopLog as defaultAppendLoopLog } from "../core/process.js"
import { dedicatedGoalOwnsContinuation, findDedicatedGoalForSession as defaultFindDedicatedGoalForSession } from "../runtime/companion-goal.js"
import { normalizedModelRef as defaultNormalizedModelRef, getSessionExecutionContext as defaultGetSessionExecutionContext } from "./session-context.js"

const DEFAULT_GOAL_ACTIVE_RECOVERY_MS = 180_000
const FALLBACK_ACTIVE_GUARD_MS = 45_000

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`createLoopRegistration requires ${name}`)
  return value
}

export function normalizeActionForCompare(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

export function sameLoopDefinition(a, b) {
  if (!a || !b) return false
  return (a.name || "") === (b.name || "") &&
    Number(a.intervalMs || 0) === Number(b.intervalMs || 0) &&
    normalizeActionForCompare(a.action) === normalizeActionForCompare(b.action) &&
    normalizeActionForCompare(a.kind) === normalizeActionForCompare(b.kind) &&
    normalizeActionForCompare(a.promptFile) === normalizeActionForCompare(b.promptFile)
}

export function createLoopRegistration(options = {}) {
  const snapshotPaths = requireFunction(options.snapshotPaths, "snapshotPaths")
  const scheduleDueWork = requireFunction(options.scheduleDueWork, "scheduleDueWork")
  const scheduleIdleWork = requireFunction(options.scheduleIdleWork, "scheduleIdleWork")
  const toast = requireFunction(options.toast, "toast")
  const say = requireFunction(options.say, "say")
  const parseLoopArgs = typeof options.parseLoopArgs === "function" ? options.parseLoopArgs : defaultParseLoopArgs
  const normalizeLoopScheduleArgs = typeof options.normalizeLoopScheduleArgs === "function" ? options.normalizeLoopScheduleArgs : defaultNormalizeLoopScheduleArgs
  const readState = typeof options.readState === "function" ? options.readState : defaultReadState
  const writeState = typeof options.writeState === "function" ? options.writeState : defaultWriteState
  const appendLoopLog = typeof options.appendLoopLog === "function" ? options.appendLoopLog : defaultAppendLoopLog
  const normalizedModelRef = typeof options.normalizedModelRef === "function" ? options.normalizedModelRef : defaultNormalizedModelRef
  const getSessionExecutionContext = typeof options.getSessionExecutionContext === "function" ? options.getSessionExecutionContext : defaultGetSessionExecutionContext
  const findDedicatedGoalForSession = typeof options.findDedicatedGoalForSession === "function" ? options.findDedicatedGoalForSession : defaultFindDedicatedGoalForSession
  const configuredGuard = Number(options.defaultActiveGuardMs)
  const defaultActiveGuardMs = Number.isFinite(configuredGuard) && configuredGuard > 0 ? configuredGuard : FALLBACK_ACTIVE_GUARD_MS

  async function addLoop(directory, client, sessionID, args, defaults = {}) {
    const normalized = normalizeLoopScheduleArgs(args, defaults)
    if (!normalized.ok) { await toast(client, normalized.error, "warning"); return }

    const parsed = parseLoopArgs(normalized.args, normalized.defaults)
    if (!parsed.ok) { await toast(client, parsed.error, "warning"); return }
    parsed.job.scheduleMode = normalized.scheduleMode
    parsed.job.scheduleSyntax = normalized.scheduleSyntax
    parsed.job.allowGoalOverlap = normalized.allowGoalOverlap === true

    const executionContext = getSessionExecutionContext(sessionID) || { agent: "build" }
    parsed.job.agent = defaults.agent || executionContext.agent || "build"
    parsed.job.model = normalizedModelRef(defaults.model) || executionContext.model
    if (defaults.testfixPreset) {
      const defaultCommand = String(defaults.verifyCommand || "npm test")
      const parsedAction = String(parsed.job.action || "").trim()
      const usedDefaultAction = parsedAction === String(defaults.action || "").trim()
      if (!usedDefaultAction && parsed.job.verifyCommand === defaults.verifyCommand) {
        parsed.job.verifyCommand = parsedAction
        parsed.job.action = `Run the project tests. Fix failures. Re-run the tests. Test command hint: ${parsedAction}`
      } else if (usedDefaultAction && parsed.job.verifyCommand !== defaults.verifyCommand) {
        parsed.job.action = `Run the project tests. Fix failures. Re-run the tests. Test command hint: ${parsed.job.verifyCommand || defaultCommand}`
      }
    }
    if (parsed.job.watchPaths.length) parsed.job.watchSnapshot = await snapshotPaths(directory, parsed.job.watchPaths)
    if (!parsed.job.activeRecoveryMs) {
      parsed.job.activeRecoveryMs = isGoalJob(parsed.job)
        ? DEFAULT_GOAL_ACTIVE_RECOVERY_MS
        : Math.max(defaultActiveGuardMs, Math.min(90_000, (parsed.job.intervalMs || 0) + 10_000))
    }

    const promptProducing = actionKind(parsed.job.action, parsed.job) === "prompt"
    if (promptProducing && !parsed.job.allowGoalOverlap) {
      const dedicatedGoal = await findDedicatedGoalForSession(directory, sessionID)
      if (dedicatedGoalOwnsContinuation(dedicatedGoal)) {
        await appendLoopLog(directory, "goal-overlap-blocked", {
          sessionID,
          job: parsed.job.name || parsed.job.id,
          goal: dedicatedGoal.id,
        })
        await toast(client, "Prompt loop not added: dedicated /goal already owns continuation in this session. Pause/finish the Goal, use another session, or pass --allow-goal-overlap intentionally.", "warning")
        return
      }
    }

    if (parsed.job.dryRun) {
      await toast(client, `Loop dry run: ${jobLabel(parsed.job)}`, "info")
      await say(client, sessionID, "OpenCode loop dry run:\n```json\n" + JSON.stringify(parsed.job, null, 2) + "\n```")
      return
    }
    const state = await readState(directory, sessionID)
    const jobs = Array.isArray(state.jobs) ? state.jobs : []

    // Default behavior is replace/upsert, not append forever. This prevents duplicate
    // loops when OpenCode emits both command.execute.before and command.executed,
    // and it matches the common expectation that /loop configures the current loop.
    let replaced = false
    if (!parsed.job.multi) {
      const targetName = parsed.job.name || "default"
      parsed.job.name = targetName
      state.jobs = jobs.filter((existing) => {
        const existingName = existing.name || "default"
        const shouldReplace = existingName === targetName || sameLoopDefinition(existing, parsed.job)
        if (shouldReplace) replaced = true
        return !shouldReplace
      })
    } else {
      state.jobs = jobs
    }

    state.jobs.push(parsed.job)
    await writeState(directory, sessionID, state)
    await scheduleDueWork(directory, client, sessionID)
    if (parsed.job.immediate) scheduleIdleWork(directory, client, sessionID)
    await toast(client, `${replaced ? "Loop replaced" : "Loop added"}: ${jobLabel(parsed.job)}`, "success")
    await appendLoopLog(directory, replaced ? "replace" : "add", {
      sessionID,
      job: parsed.job.name || parsed.job.id,
      label: jobLabel(parsed.job),
      scheduleMode: parsed.job.scheduleMode,
      scheduleSyntax: parsed.job.scheduleSyntax,
    })
  }

  return { addLoop }
}
