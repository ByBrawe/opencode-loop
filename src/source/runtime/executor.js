import { now as defaultNow } from "../core/args.js"
import { isGoalJob } from "../core/jobs.js"
import { readState as defaultReadState, writeState as defaultWriteState } from "../core/state.js"
import { appendLoopLog as defaultAppendLoopLog, runShellCommand as defaultRunShellCommand, notifyJob as defaultNotifyJob } from "../core/process.js"
import { sdkErrorMessage as defaultErrorMessage } from "../opencode/sdk.js"
import { fireSdk as defaultFireSdk, log as defaultLog, toast as defaultToast } from "../opencode/host.js"
import { dangerousShell as defaultDangerousShell } from "./job-workspace.js"
import { createSessionStatusRuntime } from "./session-status.js"
import { createCompactionRuntime } from "./compaction.js"
import { createActionDispatcher } from "./action-dispatch.js"
import { createRunFinalizationRuntime } from "./run-finalization.js"
import { createRunAdmissionRuntime } from "./run-admission.js"

const DEFAULT_ACTIVE_GUARD_MS = 45_000
const DEFAULT_BUSY_RETRY_MS = 5_000

function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`createLoopExecutor requires ${label}`)
  return value
}

export function createLoopExecutor(options = {}) {
  const workspace = options.workspace || {}
  const goalPolicy = options.goalPolicy || {}
  const scheduler = options.scheduler || {}

  const buildPrompt = requireFunction(workspace.buildPrompt, "workspace.buildPrompt")
  const ensureBranch = requireFunction(workspace.ensureBranch, "workspace.ensureBranch")
  const watchChanged = requireFunction(workspace.watchChanged, "workspace.watchChanged")
  const untilReached = requireFunction(workspace.untilReached, "workspace.untilReached")
  const createCheckpoint = requireFunction(workspace.createCheckpoint, "workspace.createCheckpoint")
  const runGoalChecks = requireFunction(goalPolicy.runGoalChecks, "goalPolicy.runGoalChecks")
  const applyGoalNoProgressGuard = requireFunction(goalPolicy.applyGoalNoProgressGuard, "goalPolicy.applyGoalNoProgressGuard")
  const rememberSession = requireFunction(scheduler.rememberSession, "scheduler.rememberSession")
  const scheduleDueWork = requireFunction(scheduler.scheduleDueWork, "scheduler.scheduleDueWork")

  const now = typeof options.now === "function" ? options.now : defaultNow
  const readState = typeof options.readState === "function" ? options.readState : defaultReadState
  const writeState = typeof options.writeState === "function" ? options.writeState : defaultWriteState
  const appendLoopLog = typeof options.appendLoopLog === "function" ? options.appendLoopLog : defaultAppendLoopLog
  const runShellCommand = typeof options.runShellCommand === "function" ? options.runShellCommand : defaultRunShellCommand
  const notifyJob = typeof options.notifyJob === "function" ? options.notifyJob : defaultNotifyJob
  const errorMessage = typeof options.errorMessage === "function" ? options.errorMessage : defaultErrorMessage
  const fireSdk = typeof options.fireSdk === "function" ? options.fireSdk : defaultFireSdk
  const log = typeof options.log === "function" ? options.log : defaultLog
  const toast = typeof options.toast === "function" ? options.toast : defaultToast
  const dangerousShell = typeof options.dangerousShell === "function" ? options.dangerousShell : defaultDangerousShell
  const activeGuardMs = Number.isFinite(Number(options.activeGuardMs)) && Number(options.activeGuardMs) > 0
    ? Number(options.activeGuardMs)
    : DEFAULT_ACTIVE_GUARD_MS
  const busyRetryMs = Number.isFinite(Number(options.busyRetryMs)) && Number(options.busyRetryMs) > 0
    ? Number(options.busyRetryMs)
    : DEFAULT_BUSY_RETRY_MS

  const activeRuns = new Map()
  const runLocks = new Map()

  const statusRuntime = createSessionStatusRuntime({
    activeRuns,
    appendLoopLog,
    now,
    activeRunCompletionFromMessages: options.activeRunCompletionFromMessages,
    staleActiveRecoveryMs: options.staleActiveRecoveryMs,
    sessionStatusCacheMs: options.sessionStatusCacheMs,
  })
  const {
    updateSessionStatusFromEvent,
    staleActiveRun,
    canFinalizeActiveRun,
    sessionIsIdle,
    markSessionStatus,
    clearSessionStatus,
  } = statusRuntime

  const compactionRuntime = createCompactionRuntime({
    activeRuns,
    finalizeActiveRun,
    appendLoopLog,
    compactSession: options.compactSession,
    log,
    errorMessage,
    now,
  })

  const actionDispatcher = createActionDispatcher({
    buildPrompt,
    compactionRuntime,
    appendLoopLog,
    sdkCall: options.sdkCall,
    normalizedModelRef: options.normalizedModelRef,
    fireSdk: options.fireSdk,
    compactTuiCommandName: options.compactTuiCommandName,
    toast,
    guardLoopOwnedUserMessage: options.guardLoopOwnedUserMessage,
    dangerousShell,
  })

  const finalizationRuntime = createRunFinalizationRuntime({
    runGoalChecks,
    applyGoalNoProgressGuard,
    createCheckpoint,
    scheduleDueWork,
    now,
    writeState,
    appendLoopLog,
    runShellCommand,
    notifyJob,
    toast,
    writeGoalReport: options.writeGoalReport,
    dangerousShell,
  })

  const admissionRuntime = createRunAdmissionRuntime({
    untilReached,
    scheduleDueWork,
    now,
    pathExists: options.pathExists,
    writeState,
    appendLoopLog,
    runShellCommand,
    notifyJob,
    toast,
    dangerousShell,
  })
  const dueJobs = admissionRuntime.dueJobs

  function clearActiveRun(sessionID) {
    const active = activeRuns.get(sessionID)
    if (active?.timer) clearTimeout(active.timer)
    compactionRuntime.clearForActiveRun(sessionID, active)
    activeRuns.delete(sessionID)
  }

  function disposeSession(sessionID) {
    clearActiveRun(sessionID)
    runLocks.delete(sessionID)
    compactionRuntime.clear(sessionID)
    clearSessionStatus(sessionID)
  }

  async function recoverActiveDispatchFailure(directory, client, sessionID, jobId, runToken, error) {
    const active = activeRuns.get(sessionID)
    if (!active || active.jobId !== jobId || active.runToken !== runToken) return false

    clearActiveRun(sessionID)
    clearSessionStatus(sessionID)

    const message = errorMessage(error)
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
    await scheduleDueWork(directory, client, sessionID, busyRetryMs)
    return true
  }

  async function finalizeActiveRun(directory, client, sessionID, finalizeOptions = {}) {
    const active = activeRuns.get(sessionID)
    if (!active) return
    if (!await canFinalizeActiveRun(directory, client, sessionID, active, finalizeOptions)) return false
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
    if (recoveredStale) {
      await appendLoopLog(directory, "active-stale-recovery", {
        sessionID,
        job: job.name || job.id,
        startedAt: active.startedAt,
      })
    }

    await finalizationRuntime.finalizeJob(directory, client, sessionID, state, job, active.job)
    return true
  }

  const fireAction = actionDispatcher.fireAction

  async function maybeRunDueJobs(directory, client, sessionID, runOptions = {}) {
    rememberSession(directory, client, sessionID)
    const reschedule = async (minDelayMs = 0) => {
      await scheduleDueWork(directory, client, sessionID, minDelayMs)
    }

    if (runLocks.has(sessionID)) {
      await reschedule(busyRetryMs)
      return
    }
    runLocks.set(sessionID, now())
    let job
    try {
      await finalizeActiveRun(directory, client, sessionID, { requireIdle: true, forceStale: true })
      if (!await sessionIsIdle(client, sessionID, directory)) {
        if (runOptions.force) await toast(client, "Loop queued: session is busy; it will run on the next idle check.", "info")
        await reschedule(busyRetryMs)
        return
      }

      const active = activeRuns.get(sessionID)
      const activeAge = active ? now() - (active.startedAt || 0) : 0
      const activeGuard = active?.job?.timeoutMs || active?.job?.activeRecoveryMs || activeGuardMs
      if (active && active.job?.noOverlap !== false && activeAge < activeGuard) {
        await reschedule(busyRetryMs)
        return
      }
      if (active && activeAge >= activeGuard) clearActiveRun(sessionID)

      const state = await readState(directory, sessionID)
      for (const candidate of state.jobs || []) {
        if (candidate.watchPaths?.length && !candidate.paused && candidate.enabled && await watchChanged(directory, candidate)) {
          candidate.watchTriggered = true
        }
      }
      const due = dueJobs(state, Boolean(runOptions.force))
      if (!due.length) {
        await writeState(directory, sessionID, state)
        await reschedule()
        return
      }
      job = due[0]

      const admission = await admissionRuntime.admitJob(directory, client, sessionID, state, job)
      if (!admission.admitted) return
      job = admission.job
      const runNowRequested = admission.runNowRequested

      job = await ensureBranch(directory, job, client, sessionID)
      const compactResult = await compactionRuntime.maybeCompact(directory, client, sessionID, job)
      job = compactResult.job
      if (compactResult.started) {
        state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
        await writeState(directory, sessionID, state)
        let timer
        if (job.timeoutMs > 0) {
          timer = setTimeout(() => {
            fireSdk(
              client,
              "session.abort",
              client.session.abort.bind(client.session),
              { path: { id: sessionID }, body: {} },
              { path: { sessionID }, body: {} },
              { sessionID },
            )
            toast(client, `Loop compact timeout fired: ${job.name || job.id}`, "warning").catch(() => {})
          }, job.timeoutMs)
        }
        const runToken = `${job.id}:compact:${now().toString(36)}:${Math.random().toString(16).slice(2)}`
        activeRuns.set(sessionID, { jobId: job.id, job, startedAt: now(), timer, runToken, compactionOnly: true })
        if (compactionRuntime.isCompleted(sessionID, job.id)) {
          await compactionRuntime.finalize(directory, client, sessionID)
          return
        }
        markSessionStatus(sessionID, "busy")
        await reschedule(busyRetryMs)
        return
      }

      if (runNowRequested) delete job.runNowRequestedAt
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
        if (job.timeoutMs > 0) {
          timer = setTimeout(() => {
            fireSdk(
              client,
              "session.abort",
              client.session.abort.bind(client.session),
              { path: { id: sessionID }, body: {} },
              { path: { sessionID }, body: {} },
              { sessionID },
            )
            toast(client, `Loop timeout fired: ${job.name || job.id}`, "warning").catch(() => {})
          }, job.timeoutMs)
        }
        const runToken = `${job.id}:${now().toString(36)}:${Math.random().toString(16).slice(2)}`
        activeRuns.set(sessionID, {
          jobId: job.id,
          job,
          startedAt: now(),
          timer,
          runToken,
          compactionAction: result.compaction === true,
        })
        if (result.compaction && compactionRuntime.isCompleted(sessionID, job.id)) {
          await compactionRuntime.finalize(directory, client, sessionID)
          return
        }
        if (result.dispatch) {
          void result.dispatch.catch((error) => {
            recoverActiveDispatchFailure(directory, client, sessionID, job.id, runToken, error)
              .catch((recoveryError) => log(client, "error", "dispatch recovery failed", { error: errorMessage(recoveryError) }))
          })
        }
        markSessionStatus(sessionID, "busy")
        await reschedule(busyRetryMs)
      } catch (error) {
        clearActiveRun(sessionID)
        await toast(client, `Loop job failed: ${error instanceof Error ? error.message : String(error)}`, "error")
        await appendLoopLog(directory, "error", {
          sessionID,
          job: job?.name || job?.id,
          error: error instanceof Error ? error.message : String(error),
        })
        await reschedule(busyRetryMs)
      }
    } finally {
      runLocks.delete(sessionID)
    }
  }

  return {
    dueJobs,
    clearActiveRun,
    disposeSession,
    recoverActiveDispatchFailure,
    finalizeActiveRun,
    fireAction,
    maybeRunDueJobs,
    sessionIsIdle,
    updateSessionStatusFromEvent,
    markSessionStatus,
    clearSessionStatus,
    noteLoopCompactionStarted: compactionRuntime.noteStarted,
    noteLoopCompactionCompleted: compactionRuntime.noteCompleted,
    getActiveRun: (sessionID) => activeRuns.get(sessionID),
    isRunLocked: (sessionID) => runLocks.has(sessionID),
  }
}
