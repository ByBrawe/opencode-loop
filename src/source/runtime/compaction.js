import { now as defaultNow } from "../core/args.js"
import { appendLoopLog as defaultAppendLoopLog } from "../core/process.js"
import { compactSession as defaultCompactSession, log as defaultLog } from "../opencode/host.js"
import { sdkErrorMessage as defaultErrorMessage } from "../opencode/sdk.js"

export function createCompactionRuntime(options = {}) {
  const activeRuns = options.activeRuns
  if (!(activeRuns instanceof Map)) throw new TypeError("createCompactionRuntime requires activeRuns Map")
  if (typeof options.finalizeActiveRun !== "function") throw new TypeError("createCompactionRuntime requires finalizeActiveRun")

  const now = typeof options.now === "function" ? options.now : defaultNow
  const appendLoopLog = typeof options.appendLoopLog === "function" ? options.appendLoopLog : defaultAppendLoopLog
  const compactSession = typeof options.compactSession === "function" ? options.compactSession : defaultCompactSession
  const log = typeof options.log === "function" ? options.log : defaultLog
  const errorMessage = typeof options.errorMessage === "function" ? options.errorMessage : defaultErrorMessage
  const finalizeActiveRun = options.finalizeActiveRun
  const requests = new Map()

  function begin(sessionID, jobId, resumeAfter = false) {
    if (typeof sessionID !== "string" || typeof jobId !== "string") return undefined
    const request = {
      jobId,
      resumeAfter: Boolean(resumeAfter),
      requestedAt: now(),
      startedAt: 0,
      completedAt: 0,
    }
    requests.set(sessionID, request)
    return request
  }

  function getPending(sessionID) {
    return requests.get(sessionID)
  }

  function clear(sessionID) {
    return requests.delete(sessionID)
  }

  function clearForActiveRun(sessionID, active) {
    const pending = requests.get(sessionID)
    if (!pending || !active || pending.jobId === active.jobId) requests.delete(sessionID)
  }

  function isCompleted(sessionID, jobId) {
    const pending = requests.get(sessionID)
    return Boolean(pending && pending.jobId === jobId && pending.completedAt)
  }

  async function start(directory, client, sessionID, jobId, model, resumeAfter = false) {
    begin(sessionID, jobId, resumeAfter)
    const ok = await compactSession(directory, client, sessionID, model)
    if (!ok) clear(sessionID)
    return ok
  }

  async function maybeCompact(directory, client, sessionID, job) {
    const dueRuns = job.compactEveryRuns > 0 && (job.runCount || 0) > 0 && (job.runCount || 0) % job.compactEveryRuns === 0 && job.lastCompactRunCount !== job.runCount
    const dueTime = job.compactEveryMs > 0 && (!job.lastCompactAt || now() - job.lastCompactAt >= job.compactEveryMs)
    if (!dueRuns && !dueTime) return { job, started: false }

    if (await start(directory, client, sessionID, job.id, job.model, true)) {
      job.lastCompactAt = now()
      job.lastCompactRunCount = job.runCount || 0
      return { job, started: true }
    }
    return { job, started: false }
  }

  async function noteStarted(directory, sessionID) {
    const pending = requests.get(sessionID)
    if (!pending) return false
    if (!pending.startedAt) {
      pending.startedAt = now()
      requests.set(sessionID, pending)
      await appendLoopLog(directory, "compact-started", {
        sessionID,
        job: pending.jobId,
        resumeAfter: pending.resumeAfter,
      })
    }
    return true
  }

  async function finalize(directory, client, sessionID) {
    const pending = requests.get(sessionID)
    const active = activeRuns.get(sessionID)
    if (!pending || !active || pending.jobId !== active.jobId) return false
    return await finalizeActiveRun(directory, client, sessionID)
  }

  async function noteCompleted(directory, client, sessionID) {
    const pending = requests.get(sessionID)
    if (!pending) return false
    pending.completedAt = now()
    requests.set(sessionID, pending)
    await appendLoopLog(directory, "compact-event", {
      sessionID,
      job: pending.jobId,
      resumeAfter: pending.resumeAfter,
    })
    const timer = setTimeout(() => {
      finalize(directory, client, sessionID)
        .catch((error) => log(client, "error", "compaction finalization failed", { error: errorMessage(error) }))
    }, 0)
    timer.unref?.()
    return true
  }

  return {
    begin,
    getPending,
    clear,
    clearForActiveRun,
    isCompleted,
    start,
    maybeCompact,
    noteStarted,
    finalize,
    noteCompleted,
  }
}
