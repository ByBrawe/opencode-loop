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
