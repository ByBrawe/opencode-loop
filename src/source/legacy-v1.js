import { promises as fs } from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { tool } from "@opencode-ai/plugin/tool"
import { now, safeID, parseDuration, splitFirst, stripOuterQuotes, escapeRegExp, takeFlag, takeFlagValue, takeAllFlagValues, parsePositiveInt, parseNonNegativeInt, parseCompactEvery, parseLoopArgs } from "./core/args.js"
import { jobLabel, matchJob, actionKind, decoratePrompt, isGoalJob } from "./core/jobs.js"
import { stateDir, ensureDir, pathExists, readState, writeState } from "./core/state.js"
import { appendLoopLog, readSmallTextFile, runProcess, runShellCommand, notifyJob } from "./core/process.js"
import { sdkErrorMessage, sdkCall } from "./opencode/sdk.js"
import { normalizedModelRef, updateSessionExecutionContext, getSessionExecutionContext, setSessionExecutionContext } from "./opencode/session-context.js"
import { fireSdk, executeTuiCommand, compactTuiCommandName, readRecentSessionMessages, orderedSessionMessages, activeRunCompletionFromMessages, resolveCompactionModel, compactSession, log, toast } from "./opencode/host.js"
import { guardLoopOwnedUserMessage, loopOwnedUserMessageGuardActive, say, clearLoopOwnedUserMessageGuard } from "./opencode/messages.js"
import { clearCommandLifecycle } from "./opencode/commands.js"
import { createCommandRouter } from "./opencode/command-router.js"
import { createGoalCommandHandlers } from "./opencode/goal-commands.js"
import { createLoopCommandHandlers } from "./opencode/loop-commands.js"
import { activeToolCalls, sessionParents, sessionStatuses, sessionStatusSeenAt, hasActiveToolCalls, markToolCallActive, markToolCallFinished, updateSessionRelationshipFromEvent, isDescendantSession, hasBusyDescendant, refreshSessionRelationships, updateToolActivityFromEvent, clearSessionActivity } from "./runtime/session-activity.js"
import { createSchedulerRuntime } from "./runtime/scheduler.js"
import { buildGoalPrompt, writeGoalReport, setGoalComplete, setGoalBlocked, setGoalProgress } from "./runtime/goal-runtime.js"
import { createGoalExecutionPolicy } from "./runtime/goal-policy.js"

const DEFAULT_ACTIVE_GUARD_MS = 45_000
const STALE_ACTIVE_RECOVERY_MS = 45_000
const BUSY_RETRY_MS = 5_000
const SESSION_STATUS_CACHE_MS = 1_500
const MAX_SCAN_FILES = 200
const MAX_SCAN_BYTES = 2_000_000
const DEFAULT_GOAL_ACTIVE_RECOVERY_MS = 180_000

const { runGoalChecks, applyGoalNoProgressGuard } = createGoalExecutionPolicy({ runShellCommand, dangerousShell, toast, appendLoopLog, now })

const activeRuns = new Map()
const runLocks = new Map()
const loopCompactionRequests = new Map()

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
    loopCompactionRequests.delete(sessionID)
    clearCommandLifecycle(sessionID)
  }
}

function dangerousShell(command) {
  const text = String(command || "").toLowerCase()
  return [
    /\brm\b(?=[^\r\n]*\s-{1,2}(?:[a-z]*r[a-z]*|recursive)\b)(?=[^\r\n]*\s-{1,2}(?:[a-z]*f[a-z]*|force)\b)/,
    /\bremove-item\b[^\r\n]*(?:-recurse|-force)/,
    /\bgit\s+reset\b/,
    /\bgit\s+clean\b/,
    /\bgit\s+push\b/,
    /\bdel\b[^\r\n]*\s\/s\b/,
    /\b(?:rmdir|rd)\b[^\r\n]*\s\/s\b/,
    /(?:^|[;&|]\s*)format(?:\.com)?\s+(?:[a-z]:|\/(?:fs|q)\b)/,
    /\bterraform\s+destroy\b/,
    /\bkubectl\s+delete\b/,
    /\bdeploy\b.*\bproduction\b/,
  ].some((pattern) => pattern.test(text))
}


async function buildPrompt(directory, job) {
  if (isGoalJob(job)) return await buildGoalPrompt(directory, job)
  const sections = []
  if (job.promptFile) {
    const text = await readSmallTextFile(path.resolve(directory, job.promptFile))
    if (text.trim()) sections.push(`Instructions from ${job.promptFile}:\n${text.trim()}`)
    else sections.push(`Prompt file ${job.promptFile} was requested but could not be read. Continue from the regular action instead.`)
  }
  if (job.action) sections.push(decoratePrompt(job))
  for (const file of job.includeFiles || []) {
    const text = await readSmallTextFile(path.resolve(directory, file), 80_000)
    if (text.trim()) sections.push(`Context from ${file}:\n${text.trim().slice(0, 20_000)}`)
  }
  return sections.join("\n\n---\n\n") || decoratePrompt(job)
}

async function ensureBranch(directory, job, client, sessionID) {
  if (!job.branch || job.branchDone) return job
  const branch = safeID(job.branch)
  const inRepo = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], directory, 10_000)
  if (inRepo.code !== 0) { job.branchDone = true; return job }
  let result = await runProcess("git", ["switch", branch], directory, 30_000)
  if (result.code !== 0) result = await runProcess("git", ["switch", "-c", branch], directory, 30_000)
  job.branchDone = true
  await toast(client, result.code === 0 ? `Loop branch active: ${branch}` : `Could not switch/create branch: ${branch}`, result.code === 0 ? "success" : "warning")
  await appendLoopLog(directory, "branch", { sessionID, branch, code: result.code })
  return job
}

async function maybeCompact(directory, client, sessionID, job) {
  const dueRuns = job.compactEveryRuns > 0 && (job.runCount || 0) > 0 && (job.runCount || 0) % job.compactEveryRuns === 0 && job.lastCompactRunCount !== job.runCount
  const dueTime = job.compactEveryMs > 0 && (!job.lastCompactAt || now() - job.lastCompactAt >= job.compactEveryMs)
  if (!dueRuns && !dueTime) return { job, started: false }
  beginLoopCompaction(sessionID, job.id, true)
  if (await compactSession(directory, client, sessionID, job.model)) {
    job.lastCompactAt = now()
    job.lastCompactRunCount = job.runCount || 0
    return { job, started: true }
  }
  loopCompactionRequests.delete(sessionID)
  return { job, started: false }
}

async function snapshotPaths(directory, files) {
  const snapshot = {}
  for (const file of files || []) {
    try {
      const stat = await fs.stat(path.resolve(directory, file))
      snapshot[file] = `${stat.mtimeMs}:${stat.size}`
    } catch { snapshot[file] = "missing" }
  }
  return snapshot
}

async function watchChanged(directory, job) {
  if (!job.watchPaths?.length) return false
  const next = await snapshotPaths(directory, job.watchPaths)
  const previous = job.watchSnapshot || {}
  const changed = job.watchPaths.some((file) => previous[file] !== next[file])
  if (changed) job.watchSnapshot = next
  return changed
}

async function fileContains(filePath, needle) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return false
    return (await fs.readFile(filePath, "utf8")).includes(needle)
  } catch { return false }
}

async function untilReached(directory, job) {
  if (!job.until) return false
  const files = ["progress.md", "PROGRESS.md", "todo.md", "TODO.md", "todolist.md", "TODOLIST.md", path.join(".opencode", "opencode-loop", "until.txt")]
  for (const file of files) if (await fileContains(path.resolve(directory, file), job.until)) return true
  let scanned = 0
  async function walk(current) {
    if (scanned >= MAX_SCAN_FILES) return false
    let entries
    try { entries = await fs.readdir(current, { withFileTypes: true }) } catch { return false }
    for (const entry of entries) {
      if (scanned >= MAX_SCAN_FILES) return false
      if ([".git", "node_modules", "dist", "build", ".next", "coverage"].includes(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { if (await walk(full)) return true }
      else if (entry.isFile() && /\.(md|txt|json|yaml|yml)$/i.test(entry.name)) { scanned++; if (await fileContains(full, job.until)) return true }
    }
    return false
  }
  return await walk(directory)
}

async function createCheckpoint(directory, sessionID, job, client) {
  if (!job.checkpointOnly && !job.gitCheckpoint) return
  const inRepo = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], directory, 10_000)
  if (inRepo.code !== 0) return
  const status = await runProcess("git", ["status", "--short"], directory, 30_000)
  if (!status.stdout.trim()) return
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const checkpointDir = path.join(stateDir(directory), "checkpoints", safeID(sessionID))
  await ensureDir(checkpointDir)
  const diff = await runProcess("git", ["diff", "--binary"], directory, 120_000)
  const staged = await runProcess("git", ["diff", "--cached", "--binary"], directory, 120_000)
  const prefix = `${timestamp}-${safeID(job.name || job.id)}`
  await fs.writeFile(path.join(checkpointDir, `${prefix}.status.txt`), status.stdout + status.stderr)
  await fs.writeFile(path.join(checkpointDir, `${prefix}.patch`), `${diff.stdout}\n${staged.stdout}`)
  if (job.gitCheckpoint) {
    await runProcess("git", ["add", "-A"], directory, 120_000)
    await runProcess("git", ["commit", "-m", `chore: opencode loop checkpoint ${timestamp}`], directory, 120_000)
  }
  await toast(client, `Loop checkpoint saved: ${prefix}`, "success")
}

function updateSessionStatusFromEvent(event) {
  const sessionID = event?.properties?.sessionID
  if (typeof sessionID !== "string") return undefined
  if (event?.type === "session.idle") {
    sessionStatuses.set(sessionID, "idle")
    sessionStatusSeenAt.set(sessionID, now())
    return { sessionID, idle: true }
  }
  if (event?.type === "session.status") {
    const status = event?.properties?.status
    const type = status && typeof status === "object" ? status.type : undefined
    if (typeof type === "string") {
      sessionStatuses.set(sessionID, type)
      sessionStatusSeenAt.set(sessionID, now())
    }
    return { sessionID, idle: type === "idle" }
  }
  return undefined
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

function staleActiveRun(sessionID) {
  const active = activeRuns.get(sessionID)
  if (!active) return false
  const age = now() - (active.startedAt || 0)
  const configured = Number(active.job?.staleActiveRecoveryMs || active.job?.activeRecoveryMs || 0)
  const threshold = Number.isFinite(configured) && configured > 0 ? configured : STALE_ACTIVE_RECOVERY_MS
  return age >= threshold
}

async function canFinalizeActiveRun(directory, client, sessionID, active, options = {}) {
  if (hasActiveToolCalls(sessionID) || hasBusyDescendant(sessionID)) return false
  if (!options.requireIdle && !options.forceStale) return true

  const completion = options.forceStale
    ? await activeRunCompletionFromMessages(directory, client, sessionID, active)
    : undefined
  if (completion === "completed") return true
  if (!options.requireIdle) return completion === "unknown" && staleActiveRun(sessionID)

  const live = await readLiveSessionStatus(client, sessionID, directory)
  if (live?.type === "idle") return true
  if (live?.type) {
    if ((live.type === "busy" || live.type === "retry") && options.forceStale && completion === "unknown" && staleActiveRun(sessionID)) return true
    return false
  }

  if (options.forceStale && completion === "unknown" && staleActiveRun(sessionID)) return true
  const cached = sessionStatuses.get(sessionID)
  const seenAt = sessionStatusSeenAt.get(sessionID) || 0
  return cached === "idle" && seenAt > (active.startedAt || 0)
}

async function readLiveSessionStatus(client, sessionID, directory) {
  const argsList = []
  if (directory) argsList.push({ query: { directory } }, { directory }, { workspace: directory })
  argsList.push({})
  for (const args of argsList) {
    try {
      const result = await client.session.status(args)
      const error = sdkError(result)
      if (error) continue
      const data = sdkData(result)
      if (!data || typeof data !== "object" || Array.isArray(data)) continue
      const observedAt = now()
      for (const [observedSessionID, observedStatus] of Object.entries(data)) {
        const observedType = observedStatus && typeof observedStatus === "object" ? observedStatus.type : undefined
        if (typeof observedType !== "string") continue
        sessionStatuses.set(observedSessionID, observedType)
        sessionStatusSeenAt.set(observedSessionID, observedAt)
      }
      // OpenCode's status list contains active sessions; idle sessions are
      // normally omitted. Clear a completed descendant that was previously busy.
      for (const childID of sessionParents.keys()) {
        if (!isDescendantSession(childID, sessionID) || data[childID]) continue
        sessionStatuses.set(childID, "idle")
        sessionStatusSeenAt.set(childID, observedAt)
      }
      if (hasBusyDescendant(sessionID)) return { type: "busy", source: "descendant" }
      const status = data?.[sessionID]
      const type = status && typeof status === "object" ? status.type : undefined
      if (typeof type === "string") return { type, source: "sdk" }
      return { type: "idle", source: "sdk" }
    } catch {}
  }
  return undefined
}

async function sessionStatusType(client, sessionID, directory, options = {}) {
  // OpenCode can briefly report an idle session while a long-running tool or
  // subtask is still executing. Tool lifecycle hooks are the more specific
  // signal here, so never enqueue another turn until every active call ends.
  if (hasActiveToolCalls(sessionID) || hasBusyDescendant(sessionID)) {
    sessionStatuses.set(sessionID, "busy")
    sessionStatusSeenAt.set(sessionID, now())
    return "busy"
  }

  const cached = sessionStatuses.get(sessionID)
  const seenAt = sessionStatusSeenAt.get(sessionID) || 0

  // Idle is safe to trust until OpenCode tells us otherwise. Busy/retry is only
  // trusted briefly: OpenCode custom commands such as /loop-status create their
  // own short assistant turn, and some TUI builds do not always emit the final
  // idle event after that turn. If we cache busy forever, due loop work can get
  // stuck at "due in every idle" until the user types another command.
  if (cached === "idle") return cached
  if (cached && now() - seenAt < SESSION_STATUS_CACHE_MS) return cached

  const live = await readLiveSessionStatus(client, sessionID, directory)
  if (live?.type) {
    // Some OpenCode 1.15.x TUI builds can leave session.status at busy after a
    // plugin-injected turn until the next user command touches the session.
    // When the only reason we still think the session is busy is our own stale
    // active-run guard, recover instead of waiting for another manual command.
    if ((live.type === "busy" || live.type === "retry") && options.recoverStaleActive !== false) {
      const active = activeRuns.get(sessionID)
      if (active) {
        const completion = await activeRunCompletionFromMessages(directory, client, sessionID, active)
        if (completion === "completed" || (completion === "unknown" && staleActiveRun(sessionID))) {
          sessionStatuses.set(sessionID, "idle")
          sessionStatusSeenAt.set(sessionID, now())
          await appendLoopLog(directory, completion === "completed" ? "status-message-complete-recovery" : "status-stale-recovery", {
            sessionID,
            job: active.job?.name || active.jobId,
            startedAt: active.startedAt,
          })
          return "idle"
        }
      }
    }
    sessionStatuses.set(sessionID, live.type)
    sessionStatusSeenAt.set(sessionID, now())
    return live.type
  }

  const fallback = activeRuns.has(sessionID) && !staleActiveRun(sessionID) ? "busy" : "idle"
  sessionStatuses.set(sessionID, fallback)
  sessionStatusSeenAt.set(sessionID, now())
  return fallback
}

async function sessionIsIdle(client, sessionID, directory, options = {}) {
  return await sessionStatusType(client, sessionID, directory, options) === "idle"
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
  const compact = loopCompactionRequests.get(sessionID)
  if (!compact || !active || compact.jobId === active.jobId) loopCompactionRequests.delete(sessionID)
  activeRuns.delete(sessionID)
}

function beginLoopCompaction(sessionID, jobId, resumeAfter = false) {
  loopCompactionRequests.set(sessionID, {
    jobId,
    resumeAfter,
    requestedAt: now(),
    startedAt: 0,
    completedAt: 0,
  })
}

async function noteLoopCompactionStarted(directory, sessionID) {
  const pending = loopCompactionRequests.get(sessionID)
  if (!pending) return false
  if (!pending.startedAt) {
    pending.startedAt = now()
    loopCompactionRequests.set(sessionID, pending)
    await appendLoopLog(directory, "compact-started", { sessionID, job: pending.jobId, resumeAfter: pending.resumeAfter })
  }
  return true
}

async function finalizeLoopCompaction(directory, client, sessionID) {
  const pending = loopCompactionRequests.get(sessionID)
  const active = activeRuns.get(sessionID)
  if (!pending || !active || pending.jobId !== active.jobId) return false
  return await finalizeActiveRun(directory, client, sessionID)
}

async function noteLoopCompactionCompleted(directory, client, sessionID) {
  const pending = loopCompactionRequests.get(sessionID)
  if (!pending) return false
  pending.completedAt = now()
  loopCompactionRequests.set(sessionID, pending)
  await appendLoopLog(directory, "compact-event", { sessionID, job: pending.jobId, resumeAfter: pending.resumeAfter })
  const timer = setTimeout(() => {
    finalizeLoopCompaction(directory, client, sessionID)
      .catch((error) => log(client, "error", "compaction finalization failed", { error: sdkErrorMessage(error) }))
  }, 0)
  timer.unref?.()
  return true
}

async function recoverActiveDispatchFailure(directory, client, sessionID, jobId, runToken, error) {
  const active = activeRuns.get(sessionID)
  if (!active || active.jobId !== jobId || active.runToken !== runToken) return false

  clearActiveRun(sessionID)
  sessionStatuses.delete(sessionID)
  sessionStatusSeenAt.delete(sessionID)

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
    const pending = loopCompactionRequests.get(sessionID)
    clearActiveRun(sessionID)
    sessionStatuses.delete(sessionID)
    sessionStatusSeenAt.delete(sessionID)
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
    beginLoopCompaction(sessionID, job.id, false)
    const ok = await compactSession(directory, client, sessionID, model)
    if (!ok) loopCompactionRequests.delete(sessionID)
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
      beginLoopCompaction(sessionID, job.id, false)
      const ok = await compactSession(directory, client, sessionID, model)
      if (!ok) loopCompactionRequests.delete(sessionID)
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
      const pending = loopCompactionRequests.get(sessionID)
      if (pending?.jobId === job.id && pending.completedAt) {
        await finalizeLoopCompaction(directory, client, sessionID)
        return
      }
      sessionStatuses.set(sessionID, "busy")
      sessionStatusSeenAt.set(sessionID, now())
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
        const pending = loopCompactionRequests.get(sessionID)
        if (pending?.jobId === job.id && pending.completedAt) {
          await finalizeLoopCompaction(directory, client, sessionID)
          return
        }
      }
      if (result.dispatch) {
        void result.dispatch.catch((error) => {
          recoverActiveDispatchFailure(directory, client, sessionID, job.id, runToken, error)
            .catch((recoveryError) => log(client, "error", "dispatch recovery failed", { error: sdkErrorMessage(recoveryError) }))
        })
      }
      sessionStatuses.set(sessionID, "busy")
      sessionStatusSeenAt.set(sessionID, now())
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

function normalizeActionForCompare(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function sameLoopDefinition(a, b) {
  if (!a || !b) return false
  return (a.name || "") === (b.name || "") &&
    Number(a.intervalMs || 0) === Number(b.intervalMs || 0) &&
    normalizeActionForCompare(a.action) === normalizeActionForCompare(b.action) &&
    normalizeActionForCompare(a.kind) === normalizeActionForCompare(b.kind) &&
    normalizeActionForCompare(a.promptFile) === normalizeActionForCompare(b.promptFile)
}

async function addLoop(directory, client, sessionID, args, defaults = {}) {
  const parsed = parseLoopArgs(args, defaults)
  if (!parsed.ok) { await toast(client, parsed.error, "warning"); return }
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
      : Math.max(DEFAULT_ACTIVE_GUARD_MS, Math.min(90_000, (parsed.job.intervalMs || 0) + 10_000))
  }
  if (parsed.job.dryRun) { await toast(client, `Loop dry run: ${jobLabel(parsed.job)}`, "info"); await say(client, sessionID, "OpenCode loop dry run:\n```json\n" + JSON.stringify(parsed.job, null, 2) + "\n```"); return }
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
  await appendLoopLog(directory, replaced ? "replace" : "add", { sessionID, job: parsed.job.name || parsed.job.id, label: jobLabel(parsed.job) })
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
