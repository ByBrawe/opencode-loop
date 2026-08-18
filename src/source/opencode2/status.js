import { durationToText } from "../core/args.js"
import { goalStatusText, isGoalJob, jobLabel } from "../core/jobs.js"

function dueAt(job, current) {
  if (Number(job?.runNowRequestedAt || 0) > 0) return current
  const intervalMs = Math.max(0, Number(job?.intervalMs || 0))
  const lastRunAt = Number(job?.lastRunAt || 0)
  if (intervalMs === 0) return current
  if (lastRunAt > 0) return lastRunAt + intervalMs
  if (job?.immediate === false) {
    const createdAt = Date.parse(job?.createdAt || "")
    return (Number.isFinite(createdAt) ? createdAt : current) + intervalMs
  }
  return current
}

export function formatOpenCode2LoopStatus(state, current = Date.now()) {
  const jobs = Array.isArray(state?.jobs) ? state.jobs : []
  const lines = jobs.length
    ? jobs.map((job, index) => {
        const dueIn = Math.max(0, dueAt(job, current) - current)
        const flags = [
          isGoalJob(job) ? `goal:${goalStatusText(job)}` : undefined,
          job.paused ? "paused" : "active",
          Number(job.runNowRequestedAt || 0) > 0 ? "run-now" : undefined,
          job.safe ? "safe" : undefined,
          job.askNever ? "ask-never" : undefined,
          job.noOverlap ? "no-overlap" : undefined,
          job.checkpointOnly ? "checkpoint-only" : undefined,
          job.gitCheckpoint ? "git-checkpoint" : undefined,
        ].filter(Boolean).join(",")
        return `${index + 1}. ${job.id}${job.name ? ` (${job.name})` : ""}: ${jobLabel(job)} | runs=${job.runCount || 0} | failures=${job.failureCount || 0} | due in ${durationToText(dueIn)} | ${flags}`
      })
    : ["No active loop jobs."]

  return Object.freeze({
    jobs,
    text: `OpenCode loop status:\n${lines.join("\n")}`,
  })
}
