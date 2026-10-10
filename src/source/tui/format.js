import { goalStatusText, isGoalJob } from "../core/jobs.js"
import {
  inferredScheduleMode,
  jobDueAt,
  jobRunnable,
  scheduleDescription,
} from "../runtime/schedule-policy.js"

// The panel reports only what Loop actually persisted. It never renders a
// completion percentage, a throughput estimate or a dispatch promise: "due" is
// a clock fact while "waiting for idle" is an admission fact, and collapsing
// the two into one countdown is exactly the confusion `/loop-status` exists to
// avoid.
const MAX_JOBS = 6
const MAX_NAME = 18
const OVERDUE_AFTER_MS = 30_000

function truncate(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

function count(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0
}

// Words stay spelled out and only the magnitudes compress. Goal uses the same
// split: readable labels, compact figures. Abbreviating the labels instead
// ("r12 f0") made the panel unreadable without a legend, and a status surface
// that needs decoding is a worse status surface.
function compactNumber(value) {
  const n = Math.max(0, Number(value) || 0)
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

function jobName(job) {
  const name = String(job?.name || "").trim()
  return name || job?.id || "job"
}

function failureReason(job) {
  const reason = String(job?.lastFailureReason || "").trim()
  return reason || ""
}

// `durationToText` only names a unit when the value divides exactly, which suits
// schedule definitions but never a live countdown. The panel repaints every two
// seconds, so it needs its own rounding or it would read "288097ms".
function humanDuration(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0))
  if (value < 1000) return `${value}ms`
  const seconds = Math.floor(value / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// Mirrors schedule-policy's scheduleState() but renders the countdown with
// humanDuration. The qualitative wording is kept identical so the panel and
// `/loop-status` never disagree about why a job has not run.
function describeScheduleState(job, current) {
  if (job?.enabled === false) return "stopped"
  if (job?.paused) return "paused"
  if (Number(job?.runNowRequestedAt || 0) > 0) return "due now; waiting for idle"

  const mode = inferredScheduleMode(job)
  const runnable = jobRunnable(job)
  if (!runnable) return "not runnable"

  const dueAt = jobDueAt(job, current)
  if (!Number.isFinite(dueAt)) return mode === "watch" ? "waiting for watched change" : "not scheduled"
  if (dueAt <= current) return mode === "idle" ? "waiting for idle" : "due; waiting for idle"
  return `due in ${humanDuration(dueAt - current)}`
}

function describeJob(job, current) {
  const parts = []
  parts.push(scheduleDescription(job))
  const runnable = jobRunnable(job)

  // An overdue runnable job is the highest-value signal: it is the state that
  // looks like a dead loop in `/loop-status` while the host is merely busy.
  const dueAt = jobDueAt(job, current)
  const overdueMs = runnable && Number.isFinite(dueAt) ? current - dueAt : Number.POSITIVE_INFINITY
  // Number.isFinite matters: an unscheduled job yields Infinity, and
  // Infinity >= threshold would otherwise render "overdue unknown".
  if (Number.isFinite(overdueMs) && overdueMs >= OVERDUE_AFTER_MS) {
    parts.push(`! overdue ${humanDuration(overdueMs)}`)
  }
  parts.push(describeScheduleState(job, current))

  parts.push(`runs ${compactNumber(count(job?.runCount))}`)
  parts.push(`fail ${compactNumber(count(job?.failureCount))}`)
  if (job?.safe) parts.push("safe")
  if (job?.askNever) parts.push("ask-never")
  if (job?.noOverlap) parts.push("no-overlap")
  return parts.join(" · ")
}

export function formatLoopSidebar(state, current = Date.now()) {
  const jobs = Array.isArray(state?.jobs) ? state.jobs.filter((job) => job && typeof job === "object") : []
  if (!jobs.length) return "OpenCode Loop\nNo loop jobs"

  const active = jobs.filter((job) => jobRunnable(job))
  const paused = jobs.filter((job) => job?.paused === true)
  const stopped = jobs.length - active.length - paused.length

  const summary = [`${jobs.length} job${jobs.length === 1 ? "" : "s"} · ${active.length} runnable`]
  if (paused.length) summary.push(`${paused.length} paused`)
  if (stopped > 0) summary.push(`${stopped} stopped`)

  const lines = ["OpenCode Loop", summary.join(" · ")]
  for (const job of jobs.slice(0, MAX_JOBS)) {
    const mark = isGoalJob(job) ? `goal:${goalStatusText(job) || "unknown"}` : jobKindLabel(job)
    lines.push(`${jobName(job)} · ${mark} · ${describeJob(job, current)}`)
  }
  if (jobs.length > MAX_JOBS) lines.push(`… +${jobs.length - MAX_JOBS} more`)

  // Surface the persisted reason a job went quiet. These are the same codes
  // written to loop.log, so the panel and the log can be correlated directly.
  const failures = jobs.map((job) => [jobName(job), failureReason(job)]).filter(([, reason]) => reason)
  for (const [name, reason] of failures.slice(0, 3)) lines.push(`! ${reason} (${truncate(name, MAX_NAME)})`)
  if (failures.length > 3) lines.push(`… +${failures.length - 3} more stop reason(s)`)

  return lines.join("\n")
}

// Only the transport kind. `jobLabel` already embeds the schedule and the
// action, which would duplicate the two most important fields on this line.
function jobKindLabel(job) {
  return truncate(String(job?.kind || "prompt").toLowerCase(), 12)
}
