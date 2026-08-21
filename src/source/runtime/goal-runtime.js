import { now } from "../core/args.js"
import { matchJob, isGoalJob } from "../core/jobs.js"
import { readState, writeState } from "../core/state.js"
import { appendLoopLog } from "../core/process.js"
import { writeGoalReport } from "./goal-report.js"

export { buildGoalPrompt } from "./goal-prompt.js"
export { goalReportPath, goalReportText, writeGoalReport } from "./goal-report.js"

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

export function hasConcreteGoalEvidence(value) {
  const text = String(value || "").trim()
  if (text.length < 24) return false
  const normalized = text.toLowerCase().replace(/\s+/g, " ")
  const weak = new Set(["done", "complete", "completed", "ok", "looks good", "n/a", "none", "no evidence", "no evidence provided", "goal completed", "marked complete"])
  if (weak.has(normalized) || normalized.startsWith("marked complete by /loop-goal-done")) return false
  return /(\b(npm|pnpm|yarn|bun|node|pytest|cargo|dotnet|go test|tsc|typecheck|test|tests|lint|build|check|checks|exit\s*\d|passed|verified|changed|updated|created|fixed|file|files|diff|commit)\b|[`\\/][\w./:-]+)/i.test(text) || text.length >= 80
}

export function goalChecksPassed(job) {
  return Array.isArray(job?.lastGoalChecks) && job.lastGoalChecks.length > 0 && job.lastGoalChecks.every((item) => Number(item?.code) === 0)
}

export function goalRequiresPassingChecks(job) {
  return job?.goalRequireChecksPass !== false && Array.isArray(job?.goalChecks) && job.goalChecks.length > 0
}

export function goalProgressSnapshot(job) {
  return {
    status: job?.goalStatus || "",
    progressCount: Array.isArray(job?.goalProgress) ? job.goalProgress.length : 0,
    evidence: String(job?.goalEvidence || ""),
    checksPassedAt: Number(job?.goalChecksPassedAt || 0),
    lastGoalCheckAt: Number(job?.lastGoalCheckAt || 0),
    lastVerifyAt: Number(job?.lastVerifyAt || 0),
    lastVerifyCode: Number.isFinite(Number(job?.lastVerifyCode)) ? Number(job.lastVerifyCode) : undefined,
  }
}

export function goalMadeMeaningfulProgress(beforeJob, afterJob) {
  const before = goalProgressSnapshot(beforeJob || {})
  const after = goalProgressSnapshot(afterJob || {})
  if (["completed", "blocked"].includes(after.status) && after.status !== before.status) return true
  if (after.progressCount > before.progressCount) return true
  if (after.evidence !== before.evidence && hasConcreteGoalEvidence(after.evidence)) return true
  if (after.checksPassedAt > before.checksPassedAt || goalChecksPassed(afterJob) && after.lastGoalCheckAt > before.lastGoalCheckAt) return true
  if (after.lastVerifyAt > before.lastVerifyAt && after.lastVerifyCode === 0) return true
  return false
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
