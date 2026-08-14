import { durationToText, now } from "../core/args.js"
import { goalStatusText, isGoalJob, jobLabel } from "../core/jobs.js"
import { readState } from "../core/state.js"

export function formatOpenCode2LoopStatus(state) {
  const jobs = Array.isArray(state?.jobs) ? state.jobs : []
  const lines = jobs.length
    ? jobs.map((job, index) => {
        const dueIn = Math.max(0, Number(job.intervalMs || 0) - (now() - Number(job.lastRunAt || 0)))
        const flags = [
          isGoalJob(job) ? `goal:${goalStatusText(job)}` : undefined,
          job.paused ? "paused" : "active",
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

export async function handleOpenCode2LoopStatus({ directory, sessionID, prompt }) {
  if (!directory) throw new TypeError("V2 loop status requires a project directory")
  if (!sessionID) throw new TypeError("V2 loop status requires a session ID")
  if (typeof prompt !== "function") throw new TypeError("V2 loop status requires a prompt function")

  const status = formatOpenCode2LoopStatus(await readState(directory, sessionID))
  await prompt({
    sessionID,
    text: status.text,
    noReply: true,
  })
  return status
}
