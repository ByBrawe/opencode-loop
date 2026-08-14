import path from "node:path"
import { spawn } from "node:child_process"
import { tool } from "@opencode-ai/plugin/tool"
import { now, parseDuration, splitFirst, stripOuterQuotes, escapeRegExp, takeFlag, takeFlagValue, takeAllFlagValues, parsePositiveInt, parseNonNegativeInt, parseCompactEvery } from "./core/args.js"
import { actionKind, isGoalJob } from "./core/jobs.js"
import { pathExists, readState, writeState } from "./core/state.js"
import { appendLoopLog, runShellCommand, notifyJob } from "./core/process.js"
import { sdkErrorMessage, sdkCall } from "./opencode/sdk.js"
import { normalizedModelRef, updateSessionExecutionContext, setSessionExecutionContext } from "./opencode/session-context.js"
import { fireSdk, executeTuiCommand, compactTuiCommandName, readRecentSessionMessages, orderedSessionMessages, resolveCompactionModel, log, toast } from "./opencode/host.js"
import { guardLoopOwnedUserMessage, loopOwnedUserMessageGuardActive, say, clearLoopOwnedUserMessageGuard } from "./opencode/messages.js"
import { clearCommandLifecycle } from "./opencode/commands.js"
import { createCommandRouter } from "./opencode/command-router.js"
import { createGoalCommandHandlers } from "./opencode/goal-commands.js"
import { createLoopCommandHandlers } from "./opencode/loop-commands.js"
import { createLoopRegistration } from "./opencode/loop-registration.js"
import { markToolCallActive, markToolCallFinished, updateSessionRelationshipFromEvent, refreshSessionRelationships, updateToolActivityFromEvent, clearSessionActivity } from "./runtime/session-activity.js"
import { createSessionStatusRuntime } from "./runtime/session-status.js"
import { createCompactionRuntime } from "./runtime/compaction.js"
import { createSchedulerRuntime } from "./runtime/scheduler.js"
import { writeGoalReport, setGoalComplete, setGoalBlocked, setGoalProgress } from "./runtime/goal-runtime.js"
import { createGoalExecutionPolicy } from "./runtime/goal-policy.js"
import { createJobWorkspaceRuntime, dangerousShell } from "./runtime/job-workspace.js"

const DEFAULT_ACTIVE_GUARD_MS = 45_000
const BUSY_RETRY_MS = 5_000

const {
  buildPrompt,
  ensureBranch,
  snapshotPaths,
  watchChanged,
  untilReached,
  createCheckpoint,
} = createJobWorkspaceRuntime({ toast })

const { runGoalChecks, applyGoalNoProgressGuard } = createGoalExecutionPolicy({ runShellCommand, dangerousShell, toast, appendLoopLog, now })

const activeRuns = new Map()
const runLocks = new Map()

const {
  updateSessionStatusFromEvent,
  staleActiveRun,
  canFinalizeActiveRun,
  sessionIsIdle,
  markSessionStatus,
  clearSessionStatus,
} = createSessionStatusRuntime({
  activeRuns,
  appendLoopLog,
  now,
})

const compactionRuntime = createCompactionRuntime({
  activeRuns,
  finalizeActiveRun,
  appendLoopLog,
  log,
  errorMessage: sdkErrorMessage,
  now,
})
const {
  maybeCompact,
  noteStarted: noteLoopCompactionStarted,
  noteCompleted: noteLoopCompactionCompleted,
} = compactionRuntime

const schedulerRuntime = createSchedulerRuntime({
  busyRetryMs: BUSY_RETRY_MS,
  sessionIsIdle,
  finalizeActiveRun,
  maybeRunDueJobs,
  appendLoopLog,
  toast,
  errorMessage: sdkErrorMessage,
})
const { rememberSession, scheduleIdleWork, scheduleDueWork, stopWatchdog, cancelDueWork } = schedulerRuntime

const { addLoop } = createLoopRegistration({
  snapshotPaths,
  scheduleDueWork,
  scheduleIdleWork,
  toast,
  say,
  defaultActiveGuardMs: DEFAULT_ACTIVE_GUARD_MS,
})

const {
  addGoal,
  statusGoal,
  pauseGoal,
  resumeGoal,
  clearGoal,
  completeGoalCommand,
  blockGoalCommand,
} = createGoalCommandHandlers({
  addLoop,
  scheduleDueWork,
  scheduleIdleWork,
  toast,
  say,
})

const {
  stopLoop,
  updateJobState,
  statusLoop,
  logsLoop,
  helpLoop,
  runNow,
  doctorLoop,
  initLoop,
  exportLoop,
} = createLoopCommandHandlers({
  clearActiveRun,
  cancelDueWork,
  stopWatchdog,
  scheduleDueWork,
  maybeRunDueJobs,
  toast,
  say,
  now,
})

const handleCommand = createCommandRouter({
  rememberSession,
  handlers: {
    addGoal,
    statusGoal,
    pauseGoal,
    resumeGoal,
    clearGoal,
    completeGoalCommand,
    blockGoalCommand,
    addLoop,
    stopLoop,
    statusLoop,
    logsLoop,
    helpLoop,
    runNow,
    updateJobState,
    doctorLoop,
    initLoop,
    exportLoop,
  },
})

function disposeRuntime(directory, client) {
  const sessions = schedulerRuntime.sessionIDsForHost(directory, client)
  for (const sessionID of sessions) {
    clearActiveRun(sessionID)
    schedulerRuntime.clearSessionScheduling(sessionID)
    runLocks.delete(sessionID)
    clearLoopOwnedUserMessageGuard(sessionID)
    clearSessionActivity(sessionID)
    compactionRuntime.clear(sessionID)
    clearCommandLifecycle(sessionID)
  }
}

function userInterruptSessionFromEvent(event) {
  if (!["message.updated", "message.created"].includes(String(event?.type || ""))) return undefined
  const props = event?.properties || {}
  const info = props.info || props.message || props
  const role = info?.role
  const sessionID = info?.sessionID || props.sessionID
  const messageID = info?.id || props.messageID
  if (role !== "user" || typeof sessionID !== "string") return undefined
  if (loopOwnedUserMessageGuardActive(sessionID, messageID)) return undefined
  return sessionID
}

async function pauseGoalsForUserInterrupt(directory, client, sessionID) {
  const state = await readState(directory, sessionID)
  const interruptedAt = now()
  let count = 0
  state.jobs = (state.jobs || []).map((job) => {
    if (!isGoalJob(job) || job.paused || job.enabled === false || ["completed", "blocked", "cleared"].includes(job.goalStatus)) return job
    count++
    return {
      ...job,
      paused: true,
      lastUserInterruptAt: interruptedAt,
      goalInterruptedReason: "Paused because the user sent a new message while the experimental goal was active.",
    }
  })
  if (!count) return false
  await writeState(directory, sessionID, state)
  await toast(client, `Paused ${count} experimental goal(s) because a new user message arrived. Resume with /loop-goal-resume.`, "warning")
  await appendLoopLog(directory, "goal-user-interrupt", { sessionID, count })
  await scheduleDueWork(directory, client, sessionID)
  return true
}

function dueJobs(state, force = false) {
  const current = now()
  return (state.jobs || []).filter((job) => {
    if (isGoalJob(job) && ["completed", "blocked", "cleared"].includes(job.goalStatus)) return false
    if (!job.enabled || job.paused) return false
    if (job.maxRuns > 0 && (job.runCount || 0) >= job.maxRuns) return false
    if (job.maxRuntimeMs > 0 && current - Date.parse(job.createdAt || new Date().toISOString()) >= job.maxRuntimeMs) return true
    if (force) return true
    if (job.watchPaths?.length) return job.watchTriggered === true
    return job.intervalMs === 0 || !job.lastRunAt || current - job.lastRunAt >= job.intervalMs
  })
}

function clearActiveRun(sessionID) {
  const active = activeRuns.get(sessionID)
  if (active?.timer) clearTimeout(active.timer)
  compactionRuntime.clearForActiveRun(sessionID, active)
  activeRuns.delete(sessionID)
}

async function recoverActiveDispatchFailure(directory, client, sessionID, jobId, runToken, error) {
  const active = activeRuns.get(sessionID)
  if (!active || active.jobId !== jobId || active.runToken !== runToken) return false

  clearActiveRun(sessionID)
  clearSessionStatus(sessionID)

  const message = sdkErrorMessage(error)
  const state = await readState(directory, sessionID)
  const job = (state.jobs || []).find((candidate) => candidate.id === jobId)
  if (job) {
    job.failureCount = (job.failureCount || 0) + 1
    job.lastFailureReason = "dispatch_failed"
    job.lastDispatchFailure = message.slice(0, 4000)
    job.lastDispatchFailureAt = now()
    if (job.maxFailures > 0 && job.failureCount >= job.maxFailures) {
      job.paused = true
      await notifyJob(directory, job, "dispatch_failed")
    }
    state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
    await writeState(directory, sessionID, state)
  }

  await appendLoopLog(directory, "dispatch-error", { sessionID, job: job?.name || jobId, error: message })
  await toast(client, `Loop dispatch failed${job?.paused ? " and paused" : ""}: ${message}`, job?.paused ? "error" : "warning")
  await scheduleDueWork(directory, client, sessionID, BUSY_RETRY_MS)
  return true
}

async function finalizeActiveRun(directory, client, sessionID, options = {}) {
  const active = activeRuns.get(sessionID)
  if (!active) return
  if (!await canFinalizeActiveRun(directory, client, sessionID, active, options)) return false
  const recoveredStale = staleActiveRun(sessionID)
  if (active.compactionOnly) {
    const pending = compactionRuntime.getPending(sessionID)
    clearActiveRun(sessionID)
    clearSessionStatus(sessionID)
    await appendLoopLog(directory, pending?.completedAt ? "compact-finished" : "compact-idle-fallback", {
      sessionID,
      job: active.job?.name || active.jobId,
      startedAt: active.startedAt,
      nativeEvent: Boolean(pending?.completedAt),
    })
    await scheduleDueWork(directory, client, sessionID)
    return true
  }
  clearActiveRun(sessionID)
  const state = await readState(directory, sessionID)
  let job = (state.jobs || []).find((candidate) => candidate.id === active.jobId)
  if (!job) return
  job.lastFinishedAt = now()
  if (recoveredStale) await appendLoopLog(directory, "active-stale-recovery", { sessionID, job: job.name || job.id, startedAt: active.startedAt })

  if (job.verifyCommand) {
    const verify = await runShellCommand(job.verifyCommand, directory, job.timeoutMs || 300_000)
    job.lastVerifyAt = now()
    job.lastVerifyCode = verify.code
    if (verify.code === 0) {
      job.failureCount = 0
      job.lastVerifyFailure = ""
      await toast(client, "Loop verify passed: " + job.verifyCommand, "success")
    } else {
      job.failureCount = (job.failureCount || 0) + 1
      job.lastVerifyFailure = (job.verifyCommand + "\nexit=" + verify.code + "\n" + verify.stdout + "\n" + verify.stderr).slice(0, 4000)
      await toast(client, "Loop verify failed: " + job.verifyCommand, "warning")
      if (job.pauseOnVerifyFail || (job.maxFailures > 0 && job.failureCount >= job.maxFailures)) {
        job.paused = true
        await notifyJob(directory, job, "verify_failed")
      }
    }
    await appendLoopLog(directory, "verify", { sessionID, job: job.name || job.id, command: job.verifyCommand, code: verify.code, failures: job.failureCount || 0 })
  }

  if (job.postrunCommand) {
    if (job.safe && dangerousShell(job.postrunCommand)) await appendLoopLog(directory, "postrun-blocked", { sessionID, job: job.name || job.id, command: job.postrunCommand })
    else {
      const postrun = await runShellCommand(job.postrunCommand, directory, job.timeoutMs || 300_000)
      job.lastPostrunCode = postrun.code
      job.lastPostrunAt = now()
      if (postrun.code !== 0) {
        job.failureCount = (job.failureCount || 0) + 1
        job.lastPostrunFailure = (job.postrunCommand + "\nexit=" + postrun.code + "\n" + postrun.stdout + "\n" + postrun.stderr).slice(0, 4000)
        if (job.maxFailures > 0 && job.failureCount >= job.maxFailures) {
          job.paused = true
          await notifyJob(directory, job, "postrun_failed")
        }
      }
      await appendLoopLog(directory, "postrun", { sessionID, job: job.name || job.id, command: job.postrunCommand, code: postrun.code })
    }
  }

  if (isGoalJob(job)) {
    job = await runGoalChecks(directory, sessionID, job, client)
    job = await applyGoalNoProgressGuard(directory, client, sessionID, job, active.job)
  }
  state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate).filter((candidate) => candidate.enabled !== false || isGoalJob(candidate))
  await writeState(directory, sessionID, state)
  if (isGoalJob(job)) await writeGoalReport(directory, sessionID, job)
  await createCheckpoint(directory, sessionID, job, client)
  await scheduleDueWork(directory, client, sessionID)
  return true
}

async function fireAction(directory, client, sessionID, job) {
  const action = String(job.action || "").trim()
  const kind = actionKind(action, job)
  const agent = job.agent || "build"
  const model = normalizedModelRef(job.model)
  if (kind === "compact") {
    const ok = await compactionRuntime.start(directory, client, sessionID, job.id, model, false)
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
      const ok = await compactionRuntime.start(directory, client, sessionID, job.id, model, false)
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
  const promptText = `${prefix}

${prompt}`
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

async function maybeRunDueJobs(directory, client, sessionID, options = {}) {
  rememberSession(directory, client, sessionID)
  const reschedule = async (minDelayMs = 0) => { await scheduleDueWork(directory, client, sessionID, minDelayMs) }

  if (runLocks.has(sessionID)) {
    await reschedule(BUSY_RETRY_MS)
    return
  }
  runLocks.set(sessionID, now())
  let job
  try {
    await finalizeActiveRun(directory, client, sessionID, { requireIdle: true, forceStale: true })
    if (!await sessionIsIdle(client, sessionID, directory)) {
      if (options.force) await toast(client, "Loop queued: session is busy; it will run on the next idle check.", "info")
      await reschedule(BUSY_RETRY_MS)
      return
    }

    const active = activeRuns.get(sessionID)
    const activeAge = active ? now() - (active.startedAt || 0) : 0
    const activeGuard = active?.job?.timeoutMs || active?.job?.activeRecoveryMs || DEFAULT_ACTIVE_GUARD_MS
    if (active && active.job?.noOverlap !== false && activeAge < activeGuard) {
      await reschedule(BUSY_RETRY_MS)
      return
    }
    if (active && activeAge >= activeGuard) clearActiveRun(sessionID)

    const state = await readState(directory, sessionID)
    for (const candidate of state.jobs || []) {
      if (candidate.watchPaths?.length && !candidate.paused && candidate.enabled && await watchChanged(directory, candidate)) candidate.watchTriggered = true
    }
    const due = dueJobs(state, options.force)
    if (!due.length) {
      await writeState(directory, sessionID, state)
      await reschedule()
      return
    }
    job = due[0]

    if (job.maxRuntimeMs > 0 && now() - Date.parse(job.createdAt || new Date().toISOString()) >= job.maxRuntimeMs) {
      state.jobs = (state.jobs || []).filter((candidate) => candidate.id !== job.id)
      await writeState(directory, sessionID, state)
      await notifyJob(directory, job, "max_runtime_reached")
      await toast(client, `Loop stopped by --max-runtime: ${job.name || job.id}`, "success")
      await appendLoopLog(directory, "max-runtime", { sessionID, job: job.name || job.id })
      await reschedule()
      return
    }
    if (job.stopFile && await pathExists(path.resolve(directory, job.stopFile))) {
      state.jobs = (state.jobs || []).filter((candidate) => candidate.id !== job.id)
      await writeState(directory, sessionID, state)
      await notifyJob(directory, job, "stop_file")
      await toast(client, "Loop stopped by --stop-file: " + job.stopFile, "success")
      await reschedule()
      return
    }
    if (await untilReached(directory, job)) {
      state.jobs = (state.jobs || []).filter((candidate) => candidate.id !== job.id)
      await writeState(directory, sessionID, state)
      await notifyJob(directory, job, "until_reached")
      await toast(client, `Loop stopped by --until: ${job.until}`, "success")
      await reschedule()
      return
    }

    if (job.preflightCommand) {
      if (job.safe && dangerousShell(job.preflightCommand)) {
        job.paused = true
        await writeState(directory, sessionID, state)
        await notifyJob(directory, job, "preflight_blocked")
        await toast(client, "Preflight blocked in safe mode and loop paused: " + job.preflightCommand, "error")
        await reschedule()
        return
      }
      const preflight = await runShellCommand(job.preflightCommand, directory, job.timeoutMs || 300_000)
      await appendLoopLog(directory, "preflight", { sessionID, job: job.name || job.id, command: job.preflightCommand, code: preflight.code })
      if (preflight.code !== 0) {
        job.paused = true
        job.failureCount = (job.failureCount || 0) + 1
        job.lastPreflightFailure = (job.preflightCommand + "\nexit=" + preflight.code + "\n" + preflight.stdout + "\n" + preflight.stderr).slice(0, 4000)
        state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
        await writeState(directory, sessionID, state)
        await notifyJob(directory, job, "preflight_failed")
        await toast(client, "Preflight failed and loop paused: " + job.preflightCommand, "warning")
        await reschedule()
        return
      }
    }

    job = await ensureBranch(directory, job, client, sessionID)
    const compactResult = await maybeCompact(directory, client, sessionID, job)
    job = compactResult.job
    if (compactResult.started) {
      state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
      await writeState(directory, sessionID, state)
      let timer
      if (job.timeoutMs > 0) timer = setTimeout(() => { fireSdk(client, "session.abort", client.session.abort.bind(client.session), { path: { id: sessionID }, body: {} }, { path: { sessionID }, body: {} }, { sessionID }); toast(client, `Loop compact timeout fired: ${job.name || job.id}`, "warning").catch(() => {}) }, job.timeoutMs)
      const runToken = `${job.id}:compact:${now().toString(36)}:${Math.random().toString(16).slice(2)}`
      activeRuns.set(sessionID, { jobId: job.id, job, startedAt: now(), timer, runToken, compactionOnly: true })
      if (compactionRuntime.isCompleted(sessionID, job.id)) {
        await compactionRuntime.finalize(directory, client, sessionID)
        return
      }
      markSessionStatus(sessionID, "busy")
      await reschedule(BUSY_RETRY_MS)
      return
    }
    job.watchTriggered = false
    job.lastRunAt = now()
    job.runCount = (job.runCount || 0) + 1
    if (job.maxRuns > 0 && job.runCount >= job.maxRuns) {
      job.enabled = false
      await notifyJob(directory, job, "max_runs_reached")
    }
    state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
    await writeState(directory, sessionID, state)
    await appendLoopLog(directory, "run", { sessionID, job: job.name || job.id, runCount: job.runCount })
    await toast(client, `Loop running: ${job.name || job.id}`, "info")

    try {
      const result = await fireAction(directory, client, sessionID, job)
      if (!result.startsAssistantTurn) {
        const fresh = await readState(directory, sessionID)
        if (result.pause) {
          fresh.jobs = (fresh.jobs || []).map((candidate) => candidate.id === job.id ? {
            ...candidate,
            paused: true,
            failureCount: (candidate.failureCount || 0) + 1,
            lastFailureReason: result.reason || "action_did_not_start",
          } : candidate)
        }
        fresh.jobs = (fresh.jobs || []).filter((candidate) => candidate.enabled !== false || isGoalJob(candidate))
        await writeState(directory, sessionID, fresh)
        await reschedule()
        return
      }
      let timer
      if (job.timeoutMs > 0) timer = setTimeout(() => { fireSdk(client, "session.abort", client.session.abort.bind(client.session), { path: { id: sessionID }, body: {} }, { path: { sessionID }, body: {} }, { sessionID }); toast(client, `Loop timeout fired: ${job.name || job.id}`, "warning").catch(() => {}) }, job.timeoutMs)
      const runToken = `${job.id}:${now().toString(36)}:${Math.random().toString(16).slice(2)}`
      activeRuns.set(sessionID, { jobId: job.id, job, startedAt: now(), timer, runToken, compactionAction: result.compaction === true })
      if (result.compaction) {
        if (compactionRuntime.isCompleted(sessionID, job.id)) {
        await compactionRuntime.finalize(directory, client, sessionID)
        return
      }
      }
      if (result.dispatch) {
        void result.dispatch.catch((error) => {
          recoverActiveDispatchFailure(directory, client, sessionID, job.id, runToken, error)
            .catch((recoveryError) => log(client, "error", "dispatch recovery failed", { error: sdkErrorMessage(recoveryError) }))
        })
      }
      markSessionStatus(sessionID, "busy")
      await reschedule(BUSY_RETRY_MS)
    } catch (error) {
      clearActiveRun(sessionID)
      await toast(client, `Loop job failed: ${error instanceof Error ? error.message : String(error)}`, "error")
      await appendLoopLog(directory, "error", { sessionID, job: job?.name || job?.id, error: error instanceof Error ? error.message : String(error) })
      await reschedule(BUSY_RETRY_MS)
    }
  } finally {
    runLocks.delete(sessionID)
  }
}

function goalTools(defaultDirectory) {
  return {
    opencode_loop_goal_complete: tool({
      description: "Mark the current OpenCode Loop experimental goal as completed. Use only after acceptance criteria are satisfied and you have evidence from tests, typecheck, build, or code inspection.",
      args: {
        summary: tool.schema.string().describe("Short human-readable summary of what was completed."),
        evidence: tool.schema.string().describe("Concrete evidence that the goal is complete, such as commands run, passing checks, files changed, and important results."),
      },
      execute: async (args, context) => {
        const result = await setGoalComplete(context.directory || defaultDirectory, context.sessionID, args)
        return { title: result.ok ? "Goal completed" : result.rejected ? "Goal completion rejected" : "Goal not found", output: result.message }
      },
    }),
    opencode_loop_goal_blocked: tool({
      description: "Mark the current OpenCode Loop experimental goal as blocked when user input or manual intervention is required.",
      args: {
        reason: tool.schema.string().describe("Why the goal is blocked."),
        needed: tool.schema.string().describe("What user input, credential, decision, or manual action is needed to continue."),
      },
      execute: async (args, context) => {
        const result = await setGoalBlocked(context.directory || defaultDirectory, context.sessionID, args)
        return { title: result.ok ? "Goal blocked" : "Goal not found", output: result.message }
      },
    }),
    opencode_loop_goal_progress: tool({
      description: "Record meaningful progress on the current OpenCode Loop experimental goal without completing it.",
      args: {
        summary: tool.schema.string().describe("What useful progress was made."),
        next: tool.schema.string().describe("The next step toward completing the goal."),
      },
      execute: async (args, context) => {
        const result = await setGoalProgress(context.directory || defaultDirectory, context.sessionID, args)
        return { title: result.ok ? "Goal progress" : "Goal not found", output: result.message }
      },
    }),
  }
}

export const OpenCodeLoopPlugin = async ({ client, directory }) => {
  // OpenCode's local SDK can be slow or unavailable while a project instance
  // is still waiting for its plugins to return their hooks. Defer bootstrap
  // calls so headless/server sessions cannot deadlock during plugin loading.
  const bootstrap = setTimeout(() => {
    log(client, "info", "Plugin initialized", { directory }).catch(() => {})
    refreshSessionRelationships(client, directory).catch(() => {})
  }, 0)
  bootstrap.unref?.()
  return {
    dispose: async () => { disposeRuntime(directory, client) },
    tool: goalTools(directory),
    "command.execute.before": async (input, output) => { await handleCommand(directory, client, input, undefined, undefined, output) },
    "tool.execute.before": async (input) => { markToolCallActive(input) },
    "tool.execute.after": async (input) => { markToolCallFinished(input) },
    "experimental.session.compacting": async (input) => { await noteLoopCompactionStarted(directory, input?.sessionID) },
    event: async ({ event }) => {
      if (event.type === "session.compacted") await noteLoopCompactionCompleted(directory, client, event?.properties?.sessionID)
      updateSessionRelationshipFromEvent(event)
      if (event.type === "message.updated") updateSessionExecutionContext(event?.properties?.info)
      updateToolActivityFromEvent(event)
      if (event.type === "command.executed") {
        const props = event.properties || {}
        await handleCommand(directory, client, props, props.name, props.arguments, undefined, "event")
      }
      const interruptedSessionID = userInterruptSessionFromEvent(event)
      if (interruptedSessionID) {
        rememberSession(directory, client, interruptedSessionID)
        await pauseGoalsForUserInterrupt(directory, client, interruptedSessionID)
      }
      const statusUpdate = updateSessionStatusFromEvent(event)
      if (statusUpdate?.sessionID) rememberSession(directory, client, statusUpdate.sessionID)
      if (statusUpdate?.idle) scheduleIdleWork(directory, client, statusUpdate.sessionID)
    },
  }
}

export default OpenCodeLoopPlugin
