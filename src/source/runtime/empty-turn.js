import { actionKind } from "../core/jobs.js"

export const DEFAULT_MAX_EMPTY_TURNS = 2

export function guardsEmptyAssistantTurn(job) {
  const kind = actionKind(job?.action, job || {})
  return kind === "prompt" || kind === "goal"
}

export function emptyTurnLimit(job) {
  const configured = Number(job?.maxEmptyTurns || 0)
  if (Number.isFinite(configured) && configured > 0) return Math.max(1, Math.floor(configured))
  return DEFAULT_MAX_EMPTY_TURNS
}

export function refundEmptyAssistantTurn(job, active = {}, timestamp = Date.now()) {
  const chargedCount = Number(active?.job?.runCount ?? job?.runCount ?? 0)
  const currentCount = Number(job?.runCount || 0)
  if (chargedCount > 0 && currentCount >= chargedCount) job.runCount = Math.max(0, currentCount - 1)

  if (Number.isFinite(Number(active?.previousLastRunAt))) job.lastRunAt = Number(active.previousLastRunAt)
  if (active?.disabledByMaxRuns && Number(job?.maxRuns || 0) > 0 && Number(job?.runCount || 0) < Number(job.maxRuns)) {
    job.enabled = true
  }

  job.emptyTurnCount = Number(job.emptyTurnCount || 0) + 1
  job.lastEmptyTurnAt = Number(timestamp) || Date.now()
  job.lastFailureReason = "empty_turn"

  const limit = emptyTurnLimit(job)
  const paused = job.emptyTurnCount >= limit
  if (paused) {
    job.paused = true
    delete job.runNowRequestedAt
  } else {
    job.runNowRequestedAt = Math.max(1, Number(timestamp) || Date.now())
  }
  return { job, paused, count: job.emptyTurnCount, limit }
}

export function clearEmptyAssistantTurnStreak(job) {
  if (!job) return job
  job.emptyTurnCount = 0
  if (job.lastFailureReason === "empty_turn") delete job.lastFailureReason
  return job
}
