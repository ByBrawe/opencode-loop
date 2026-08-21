import { now } from "../core/args.js"
import { matchJob, isGoalJob } from "../core/jobs.js"
import { readState, writeState } from "../core/state.js"
import { appendLoopLog } from "../core/process.js"
import { writeGoalReport } from "./goal-report.js"
import { hasConcreteGoalEvidence, goalChecksPassed, goalRequiresPassingChecks } from "./goal-evidence.js"

export { buildGoalPrompt } from "./goal-prompt.js"
export { goalReportPath, goalReportText, writeGoalReport } from "./goal-report.js"
export { hasConcreteGoalEvidence, goalChecksPassed, goalRequiresPassingChecks, goalProgressSnapshot, goalMadeMeaningfulProgress } from "./goal-evidence.js"

export function pickGoalJob(state, target = "") {
  const goals = (state.jobs || []).filter(isGoalJob)
  if (!goals.length) return undefined
  const text = String(target || "").trim()
  if (!text || ["active", "current", "goal"].includes(text.toLowerCase())) return goals.find((job) => job.goalStatus === "active" && job.enabled !== false) || goals[0]
  return goals.find((job, index) => matchJob(job, text, index))
}

export function parseGoalToolText(args, fields) {
  const result = {}
  for (const field of fields) result[field] = String(args?.[field] || "").trim()
  return result
}

export async function rejectGoalCompletion(directory, sessionID, state, job, reason) {
  job.goalCompletionRejectedAt = now()
  job.goalCompletionRejectedReason = reason
  job.goalCompletionRejectedCount = (job.goalCompletionRejectedCount || 0) + 1
  state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
  await writeState(directory, sessionID, state)
  await writeGoalReport(directory, sessionID, job)
  await appendLoopLog(directory, "goal-complete-rejected", { sessionID, job: job.name || job.id, reason })
  return { ok: false, job, rejected: true, message: `Goal completion rejected: ${reason}` }
}

export async function setGoalComplete(directory, sessionID, args = {}) {
  const state = await readState(directory, sessionID)
  const job = pickGoalJob(state, args.target)
  if (!job) return { ok: false, message: "No active experimental goal was found." }
  const parsed = parseGoalToolText(args, ["summary", "evidence"])
  const manualOverride = args.manual === true || args.manualOverride === true
  const completionEvidence = parsed.evidence || job.goalEvidence || ""
  const skipEvidenceGate = manualOverride || args.allowWeakEvidence === true || job.goalRequireEvidence === false
  const skipCheckGate = manualOverride || args.allowFailingChecks === true || job.goalRequireChecksPass === false
  if (!skipEvidenceGate && !hasConcreteGoalEvidence(completionEvidence)) {
    return await rejectGoalCompletion(directory, sessionID, state, job, "concrete evidence is required before the goal tool can complete the goal")
  }
  if (!skipCheckGate && goalRequiresPassingChecks(job) && !goalChecksPassed(job)) {
    return await rejectGoalCompletion(directory, sessionID, state, job, "configured goal checks have not passed yet")
  }
  job.goalStatus = "completed"
  job.enabled = false
  job.paused = true
  job.goalCompletedAt = now()
  job.goalSummary = parsed.summary || job.goalSummary || "Goal completed."
  job.goalEvidence = completionEvidence || "No evidence provided."
  job.noProgressCount = 0
  state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
  await writeState(directory, sessionID, state)
  await writeGoalReport(directory, sessionID, job)
  await appendLoopLog(directory, "goal-complete", { sessionID, job: job.name || job.id, summary: job.goalSummary })
  return { ok: true, job, message: `Goal completed: ${job.goalSummary}` }
}

export async function setGoalBlocked(directory, sessionID, args = {}) {
  const state = await readState(directory, sessionID)
  const job = pickGoalJob(state, args.target)
  if (!job) return { ok: false, message: "No active experimental goal was found." }
  const parsed = parseGoalToolText(args, ["reason", "needed", "evidence"])
  job.goalStatus = "blocked"
  job.enabled = false
  job.paused = true
  job.goalBlockedAt = now()
  job.goalBlockedReason = [parsed.reason, parsed.needed ? `Needed: ${parsed.needed}` : ""].filter(Boolean).join("\n") || "Goal blocked."
  if (parsed.evidence) job.goalEvidence = parsed.evidence
  state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
  await writeState(directory, sessionID, state)
  await writeGoalReport(directory, sessionID, job)
  await appendLoopLog(directory, "goal-blocked", { sessionID, job: job.name || job.id, reason: job.goalBlockedReason })
  return { ok: true, job, message: `Goal blocked: ${job.goalBlockedReason}` }
}

export async function setGoalProgress(directory, sessionID, args = {}) {
  const state = await readState(directory, sessionID)
  const job = pickGoalJob(state, args.target)
  if (!job) return { ok: false, message: "No active experimental goal was found." }
  const parsed = parseGoalToolText(args, ["summary", "next", "evidence"])
  const item = { time: new Date().toISOString(), summary: parsed.summary || "Progress recorded.", next: parsed.next || "", evidence: parsed.evidence || "" }
  job.goalProgress = [...(job.goalProgress || []), item].slice(-30)
  if (parsed.evidence) job.goalEvidence = parsed.evidence
  job.noProgressCount = 0
  job.lastProgressAt = now()
  state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
  await writeState(directory, sessionID, state)
  await writeGoalReport(directory, sessionID, job)
  await appendLoopLog(directory, "goal-progress", { sessionID, job: job.name || job.id, summary: item.summary })
  return { ok: true, job, message: `Goal progress recorded: ${item.summary}` }
}
