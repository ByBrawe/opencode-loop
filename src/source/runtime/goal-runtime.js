import { promises as fs } from "node:fs"
import path from "node:path"
import { DEFAULT_GOAL_MAX_NO_PROGRESS, now, safeID } from "../core/args.js"
import { matchJob, isGoalJob, goalStatusText } from "../core/jobs.js"
import { stateDir, ensureDir, readState, writeState } from "../core/state.js"
import { appendLoopLog, readSmallTextFile } from "../core/process.js"

const GOAL_REPORT_DIR = "goals"
const GOAL_PROMPT_PREFIX = "EXPERIMENTAL OPENCODE GOAL MODE ITERATION"

export async function buildGoalPrompt(directory, job) {
  const sections = []
  sections.push(`Working directory:\n${path.resolve(directory)}\nKeep every file operation inside this directory. Prefer workspace-relative paths such as \"src/index.js\"; never turn a relative path into a root path such as \"/src/index.js\".`)
  const objective = String(job.action || "").trim()
  if (objective) sections.push(`Goal objective:\n${objective}`)
  if (job.goalFile) {
    const text = await readSmallTextFile(path.resolve(directory, job.goalFile), 120_000)
    if (text.trim()) sections.push(`Goal file ${job.goalFile}:\n${text.trim()}`)
    else sections.push(`Goal file ${job.goalFile} was requested but could not be read. Continue from the inline goal objective.`)
  }
  if (job.promptFile) {
    const text = await readSmallTextFile(path.resolve(directory, job.promptFile), 120_000)
    if (text.trim()) sections.push(`Extra goal instructions from ${job.promptFile}:\n${text.trim()}`)
  }
  if (job.goalAcceptance?.length) sections.push("Acceptance criteria:\n" + job.goalAcceptance.map((item, index) => `${index + 1}. ${item}`).join("\n"))
  if (job.goalChecks?.length) sections.push("Verification commands that define useful evidence:\n" + job.goalChecks.map((item, index) => `${index + 1}. ${item}`).join("\n"))
  if (job.verifyCommand) sections.push(`Post-turn verify command configured by the loop: ${job.verifyCommand}`)
  if (job.lastGoalChecks?.length) sections.push("Latest goal check results:\n" + job.lastGoalChecks.map((item) => `- ${item.command}: exit ${item.code}`).join("\n"))
  if (job.lastVerifyFailure) sections.push("Previous verify/check failure summary:\n" + String(job.lastVerifyFailure).slice(0, 1600))
  if (job.goalCompletionRejectedReason) sections.push(`Previous completion attempt was rejected:\n${job.goalCompletionRejectedReason}`)
  if ((job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS) > 0) sections.push(`No-progress guard:\n${job.noProgressCount || 0}/${job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS} recent turn(s) without recorded meaningful progress.`)
  if (job.goalProgress?.length) sections.push("Recent goal progress:\n" + job.goalProgress.slice(-5).map((item) => `- ${item.time}: ${item.summary}`).join("\n"))
  for (const file of job.includeFiles || []) {
    const text = await readSmallTextFile(path.resolve(directory, file), 80_000)
    if (text.trim()) sections.push(`Context from ${file}:\n${text.trim().slice(0, 20_000)}`)
  }

  return `${GOAL_PROMPT_PREFIX}.

You are pursuing an experimental persistent goal for this OpenCode session. This is not a timer loop and not a one-shot prompt. Keep working toward the goal until it is completed, blocked, paused, cleared, or stopped by safety limits.

Rules:
- Work on the next smallest useful step toward the goal.
- Prefer direct code changes, tests, typechecks, builds, and evidence over discussion.
- Do not claim the goal is complete unless the acceptance criteria are satisfied and verification evidence supports it.
- If verification commands are configured, do not call opencode_loop_goal_complete until the latest relevant checks have passed unless the user explicitly overrides the goal.
- Completion evidence must be concrete: mention commands, files, checks, results, or code inspection details.
- When the goal is complete, call the tool opencode_loop_goal_complete with a summary and evidence.
- If you are truly blocked and need user input, call the tool opencode_loop_goal_blocked with the reason and what is needed.
- If you made meaningful progress but the goal is not complete, call the tool opencode_loop_goal_progress with the summary and next step.
- If you cannot make meaningful progress for this turn, call opencode_loop_goal_blocked instead of repeating the same attempt.
- Do not call completion tools just to be polite; only call them when the state is real.
- Do not ask the user questions unless blocked; make reasonable assumptions and continue.
- Follow safety rules: no destructive commands, force pushes, production deploys, production database resets, or deleting user data.

${sections.join("\n\n---\n\n")}`
}

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
