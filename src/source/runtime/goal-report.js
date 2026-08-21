import { promises as fs } from "node:fs"
import path from "node:path"
import { DEFAULT_GOAL_MAX_NO_PROGRESS, safeID } from "../core/args.js"
import { isGoalJob, goalStatusText } from "../core/jobs.js"
import { stateDir, ensureDir } from "../core/state.js"

const GOAL_REPORT_DIR = "goals"

export function goalReportPath(directory, sessionID, job) {
  return path.join(stateDir(directory), GOAL_REPORT_DIR, `${safeID(sessionID)}-${safeID(job.name || job.id)}.md`)
}

export function goalReportText(job) {
  const lines = []
  lines.push(`# OpenCode Loop Goal Report`)
  lines.push("")
  lines.push(`Status: ${goalStatusText(job) || "unknown"}`)
  lines.push(`Goal: ${job.action || job.goalFile || ""}`)
  lines.push(`Created: ${job.createdAt || ""}`)
  if (job.goalCompletedAt) lines.push(`Completed: ${new Date(job.goalCompletedAt).toISOString()}`)
  if (job.goalBlockedAt) lines.push(`Blocked: ${new Date(job.goalBlockedAt).toISOString()}`)
  if (job.lastUserInterruptAt) lines.push(`Paused by user message: ${new Date(job.lastUserInterruptAt).toISOString()}`)
  if (job.goalNoProgressPausedAt) lines.push(`Paused by no-progress guard: ${new Date(job.goalNoProgressPausedAt).toISOString()}`)
  if (job.runCount) lines.push(`Turns: ${job.runCount}`)
  if ((job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS) > 0) lines.push(`No-progress: ${job.noProgressCount || 0}/${job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS}`)
  lines.push("")
  if (job.goalSummary) lines.push("## Summary", "", String(job.goalSummary), "")
  if (job.goalEvidence) lines.push("## Evidence", "", String(job.goalEvidence), "")
  if (job.goalBlockedReason) lines.push("## Blocked reason", "", String(job.goalBlockedReason), "")
  if (job.goalCompletionRejectedReason) lines.push("## Last completion rejection", "", String(job.goalCompletionRejectedReason), "")
  if (job.goalInterruptedReason) lines.push("## Interrupt", "", String(job.goalInterruptedReason), "")
  if (job.goalNoProgressReason) lines.push("## No-progress guard", "", String(job.goalNoProgressReason), "")
  if (job.goalAcceptance?.length) lines.push("## Acceptance criteria", "", ...job.goalAcceptance.map((item) => `- ${item}`), "")
  if (job.lastGoalChecks?.length) {
    lines.push("## Latest checks", "")
    for (const item of job.lastGoalChecks) lines.push(`- ${item.command}: exit ${item.code}`)
    lines.push("")
  }
  if (job.goalProgress?.length) {
    lines.push("## Progress", "")
    for (const item of job.goalProgress) lines.push(`- ${item.time}: ${item.summary}${item.next ? ` Next: ${item.next}` : ""}`)
    lines.push("")
  }
  return lines.join("\n")
}

export async function writeGoalReport(directory, sessionID, job) {
  if (!isGoalJob(job)) return
  const target = job.goalEvidenceFile ? path.resolve(directory, job.goalEvidenceFile) : goalReportPath(directory, sessionID, job)
  await ensureDir(path.dirname(target))
  await fs.writeFile(target, goalReportText(job), "utf8")
}
