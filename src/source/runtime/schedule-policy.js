import { durationToText } from "../core/args.js"
import { isGoalJob } from "../core/jobs.js"

const TERMINAL_GOAL_STATUSES = new Set(["completed", "blocked", "cleared"])

export function inferredScheduleMode(job) {
  const explicit = String(job?.scheduleMode || "").toLowerCase()
  if (["idle", "interval", "once", "watch"].includes(explicit)) return explicit
  if (job?.watchPaths?.length) return "watch"
  if (Number(job?.maxRuns || 0) === 1 && job?.immediate === false && Number(job?.intervalMs || 0) > 0) return "once"
  return Number(job?.intervalMs || 0) === 0 ? "idle" : "interval"
}

export function jobRunnable(job) {
  if (!job) return false
  if (isGoalJob(job) && TERMINAL_GOAL_STATUSES.has(job.goalStatus)) return false
  if (!job.enabled || job.paused) return false
  if (Number(job.maxRuns || 0) > 0 && Number(job.runCount || 0) >= Number(job.maxRuns || 0)) return false
  return true
}

export function jobDueAt(job, current = Date.now()) {
  if (!jobRunnable(job)) return Infinity
  if (Number(job.runNowRequestedAt || 0) > 0) return current

  const created = Date.parse(job.createdAt || "")
  if (Number(job.maxRuntimeMs || 0) > 0 && Number.isFinite(created) && current - created >= Number(job.maxRuntimeMs || 0)) return current

  if (job.watchPaths?.length) return job.watchTriggered === true ? current : Infinity

  const intervalMs = Number(job.intervalMs || 0)
  if (intervalMs === 0) return current

  const lastRunAt = Number(job.lastRunAt || 0)
  if (!lastRunAt) {
    if (job.immediate === false) return (Number.isFinite(created) ? created : current) + intervalMs
    return current
  }
  return lastRunAt + intervalMs
}

export function jobIsDue(job, current = Date.now(), force = false) {
  if (!jobRunnable(job)) return false
  if (force) return true
  return jobDueAt(job, current) <= current
}

export function dueJobs(state, current = Date.now(), force = false) {
  return (state?.jobs || [])
    .filter((job) => jobIsDue(job, current, force))
    .sort((a, b) => Number(Number(b.runNowRequestedAt || 0) > 0) - Number(Number(a.runNowRequestedAt || 0) > 0))
}

export function nextDueDelay(state, current = Date.now()) {
  let soonest = Infinity
  for (const job of state?.jobs || []) soonest = Math.min(soonest, jobDueAt(job, current))
  if (!Number.isFinite(soonest)) return Infinity
  return Math.max(0, soonest - current)
}

export function scheduleDescription(job) {
  const mode = inferredScheduleMode(job)
  const intervalMs = Number(job?.intervalMs || 0)
  if (mode === "idle") return "every idle"
  if (mode === "watch") return `on watch: ${(job.watchPaths || []).join(", ")}`
  if (mode === "once") return intervalMs > 0 ? `once after ${durationToText(intervalMs)}` : "once on next idle"
  if (job?.immediate === false) return `every ${durationToText(intervalMs)}, first after ${durationToText(intervalMs)}`
  return `every ${durationToText(intervalMs)}, starts on next idle`
}

export function scheduleState(job, current = Date.now()) {
  if (!job?.enabled) return "stopped"
  if (job?.paused) return "paused"
  if (Number(job?.runNowRequestedAt || 0) > 0) return "due now; waiting for idle"
  const mode = inferredScheduleMode(job)
  const dueAt = jobDueAt(job, current)
  if (!Number.isFinite(dueAt)) return mode === "watch" ? "waiting for watched change" : "not scheduled"
  if (dueAt <= current) return mode === "idle" ? "waiting for idle" : "due; waiting for idle"
  return `due in ${durationToText(dueAt - current)}`
}
