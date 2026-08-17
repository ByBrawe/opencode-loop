import { now } from "../core/args.js"
import { isGoalJob } from "../core/jobs.js"
import { readState } from "../core/state.js"

const DEFAULT_IDLE_DEBOUNCE_MS = 1_200
const DEFAULT_BUSY_RETRY_MS = 5_000
const DEFAULT_MIN_DUE_TIMER_MS = 250
const DEFAULT_MAX_DUE_TIMER_MS = 2_147_000_000
const DEFAULT_HEARTBEAT_MS = 2_500
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000

export function jobDueAt(job, current = now()) {
  if (isGoalJob(job) && ["completed", "blocked", "cleared"].includes(job.goalStatus)) return Infinity
  if (!job.enabled || job.paused) return Infinity
  if (job.maxRuns > 0 && (job.runCount || 0) >= job.maxRuns) return Infinity
  if (job.watchPaths?.length) return Infinity
  const created = Date.parse(job.createdAt || "")
  if (job.maxRuntimeMs > 0 && Number.isFinite(created) && current - created >= job.maxRuntimeMs) return current
  if (job.intervalMs === 0) return current
  if (!job.lastRunAt) {
    if (job.immediate === false) return (Number.isFinite(created) ? created : current) + (job.intervalMs || 0)
    return current
  }
  return job.lastRunAt + (job.intervalMs || 0)
}

export function nextDueDelay(state, current = now()) {
  let soonest = Infinity
  for (const job of state.jobs || []) soonest = Math.min(soonest, jobDueAt(job, current))
  if (!Number.isFinite(soonest)) return Infinity
  return Math.max(0, soonest - current)
}

export function createSchedulerRuntime(options = {}) {
  const idleTimers = new Map()
  const dueTimers = new Map()
  const watchdogTimers = new Map()
  const knownSessions = new Map()
  let heartbeatTimer

  const clock = options.now || now
  const readStateFn = options.readState || readState
  const setTimeoutFn = options.setTimeout || setTimeout
  const clearTimeoutFn = options.clearTimeout || clearTimeout
  const setIntervalFn = options.setInterval || setInterval
  const clearIntervalFn = options.clearInterval || clearInterval
  const idleDebounceMs = options.idleDebounceMs ?? DEFAULT_IDLE_DEBOUNCE_MS
  const busyRetryMs = options.busyRetryMs ?? DEFAULT_BUSY_RETRY_MS
  const minDueTimerMs = options.minDueTimerMs ?? DEFAULT_MIN_DUE_TIMER_MS
  const maxDueTimerMs = options.maxDueTimerMs ?? DEFAULT_MAX_DUE_TIMER_MS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS

  const errorMessage = (error) => options.errorMessage ? options.errorMessage(error) : (error instanceof Error ? error.message : String(error || "unknown error"))
  const appendLog = async (directory, event, extra) => { if (options.appendLoopLog) await options.appendLoopLog(directory, event, extra) }
  const toast = async (client, message, level) => { if (options.toast) await options.toast(client, message, level) }

  function stopHeartbeatIfIdle() {
    if (!knownSessions.size && heartbeatTimer) {
      clearIntervalFn(heartbeatTimer)
      heartbeatTimer = undefined
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer) return
    heartbeatTimer = setIntervalFn(() => {
      for (const [sessionID, info] of [...knownSessions.entries()]) {
        if (!info || clock() - (info.seenAt || 0) > sessionTtlMs) {
          knownSessions.delete(sessionID)
          continue
        }
        Promise.resolve()
          .then(async () => {
            await options.finalizeActiveRun?.(info.directory, info.client, sessionID, { requireIdle: true, forceStale: true })
            await options.maybeRunDueJobs?.(info.directory, info.client, sessionID, { heartbeat: true })
          })
          .catch((error) => appendLog(info.directory, "heartbeat-error", { sessionID, error: errorMessage(error) }).catch(() => {}))
      }
      stopHeartbeatIfIdle()
    }, heartbeatMs)
  }

  function rememberSession(directory, client, sessionID) {
    if (!sessionID) return
    knownSessions.set(sessionID, { directory, client, seenAt: clock() })
    startHeartbeat()
  }

  function cancelIdleWork(sessionID) {
    const timer = idleTimers.get(sessionID)
    if (timer) clearTimeoutFn(timer)
    idleTimers.delete(sessionID)
  }

  function cancelDueWork(sessionID) {
    const timer = dueTimers.get(sessionID)
    if (timer) clearTimeoutFn(timer)
    dueTimers.delete(sessionID)
  }

  function scheduleIdleWork(directory, client, sessionID) {
    cancelIdleWork(sessionID)
    const timer = setTimeoutFn(() => {
      idleTimers.delete(sessionID)
      Promise.resolve()
        .then(async () => {
          if (!await options.sessionIsIdle?.(client, sessionID, directory)) {
            await scheduleDueWork(directory, client, sessionID, busyRetryMs)
            return
          }
          await options.finalizeActiveRun?.(directory, client, sessionID)
          if (!await options.sessionIsIdle?.(client, sessionID, directory)) {
            await scheduleDueWork(directory, client, sessionID, busyRetryMs)
            return
          }
          await options.maybeRunDueJobs?.(directory, client, sessionID)
        })
        .catch((error) => {
          toast(client, `Loop idle handler failed: ${errorMessage(error)}`, "error").catch(() => {})
          appendLog(directory, "idle-error", { sessionID, error: errorMessage(error) }).catch(() => {})
        })
    }, idleDebounceMs)
    idleTimers.set(sessionID, timer)
  }

  async function startWatchdog(directory, client, sessionID) {
    if (watchdogTimers.has(sessionID)) return
    const timer = setIntervalFn(() => {
      Promise.resolve()
        .then(async () => {
          const state = await readStateFn(directory, sessionID)
          const delay = nextDueDelay(state, clock())
          const hasJobs = (state.jobs || []).some((job) => job.enabled !== false && !job.paused && (!isGoalJob(job) || !["completed", "blocked", "cleared"].includes(job.goalStatus)))
          if (!hasJobs || !Number.isFinite(delay)) {
            stopWatchdog(sessionID)
            return
          }
          if (delay <= 0) await options.maybeRunDueJobs?.(directory, client, sessionID)
          else await scheduleDueWork(directory, client, sessionID)
        })
        .catch((error) => appendLog(directory, "watchdog-error", { sessionID, error: errorMessage(error) }).catch(() => {}))
    }, Math.max(1_000, busyRetryMs))
    watchdogTimers.set(sessionID, timer)
  }

  function stopWatchdog(sessionID) {
    const timer = watchdogTimers.get(sessionID)
    if (timer) clearIntervalFn(timer)
    watchdogTimers.delete(sessionID)
  }

  async function scheduleDueWork(directory, client, sessionID, minDelayMs = 0) {
    cancelDueWork(sessionID)

    const state = await readStateFn(directory, sessionID)
    const delay = nextDueDelay(state, clock())
    if (!Number.isFinite(delay)) return

    const wait = Math.min(Math.max(delay, minDelayMs, minDueTimerMs), maxDueTimerMs)
    const timer = setTimeoutFn(() => {
      dueTimers.delete(sessionID)
      Promise.resolve()
        .then(async () => {
          if (!await options.sessionIsIdle?.(client, sessionID, directory)) {
            await scheduleDueWork(directory, client, sessionID, busyRetryMs)
            return
          }
          await options.finalizeActiveRun?.(directory, client, sessionID)
          if (!await options.sessionIsIdle?.(client, sessionID, directory)) {
            await scheduleDueWork(directory, client, sessionID, busyRetryMs)
            return
          }
          await options.maybeRunDueJobs?.(directory, client, sessionID)
        })
        .catch((error) => {
          toast(client, `Loop due timer failed: ${errorMessage(error)}`, "error").catch(() => {})
          appendLog(directory, "due-timer-error", { sessionID, error: errorMessage(error) }).catch(() => {})
        })
    }, wait)
    dueTimers.set(sessionID, timer)
    await startWatchdog(directory, client, sessionID)
  }

  function sessionIDsForHost(directory, client) {
    return [...knownSessions.entries()]
      .filter(([, info]) => info?.directory === directory && info?.client === client)
      .map(([sessionID]) => sessionID)
  }

  function clearSessionScheduling(sessionID) {
    cancelIdleWork(sessionID)
    cancelDueWork(sessionID)
    stopWatchdog(sessionID)
    knownSessions.delete(sessionID)
    stopHeartbeatIfIdle()
  }

  return {
    rememberSession,
    scheduleIdleWork,
    scheduleDueWork,
    startWatchdog,
    stopWatchdog,
    cancelIdleWork,
    cancelDueWork,
    sessionIDsForHost,
    clearSessionScheduling,
    knownSessionCount: () => knownSessions.size,
  }
}
