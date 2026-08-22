const TRANSIENT_NETWORK_PATTERNS = [
  /\b(?:408|425|429|500|502|503|504|524)\b/i,
  /rate[\s_-]?limit|too many requests|overloaded|service[\s_-]?unavailable|provider[_ -]?unavailable/i,
  /terminated|fetch failed|failed to fetch|network[\s_-]?error|network connection lost/i,
  /connection (?:error|refused|lost)|socket (?:hang up|connection was closed)|reset before headers/i,
  /\b(?:enotfound|eai_again|econnrefused|econnreset|etimedout|ehostunreach|enetunreach|epipe)\b/i,
  /\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /\btimeout(?:error)?\b/i,
]

function errorText(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === "string") return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

export function isTransientNetworkError(value) {
  const text = errorText(value)
  return TRANSIENT_NETWORK_PATTERNS.some((pattern) => pattern.test(text))
}

export function networkRetryDelayMs(attempt, baseMs = 5_000, maxMs = 60_000) {
  const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1))
  const safeBase = Math.max(1, Math.floor(Number(baseMs) || 5_000))
  const safeMax = Math.max(safeBase, Math.floor(Number(maxMs) || 60_000))
  return Math.min(safeMax, safeBase * (2 ** Math.min(8, safeAttempt - 1)))
}

export function refundInfrastructureRun(job, snapshot = {}, input = {}) {
  const chargedCount = Number(snapshot.runCount ?? job.runCount ?? 0)
  const currentCount = Number(job.runCount || 0)
  if (chargedCount > 0 && currentCount >= chargedCount) job.runCount = Math.max(0, currentCount - 1)
  if (Number.isFinite(Number(snapshot.previousLastRunAt))) job.lastRunAt = Number(snapshot.previousLastRunAt)
  if (snapshot.disabledByMaxRuns && job.maxRuns > 0 && job.runCount < job.maxRuns) job.enabled = true
  job.infrastructureFailureCount = (job.infrastructureFailureCount || 0) + 1
  job.lastInfrastructureFailure = String(input.reason || "transient_network_failure").slice(0, 120)
  job.lastInfrastructureError = errorText(input.error).slice(0, 4000)
  job.lastInfrastructureFailureAt = Number(input.now || Date.now())
  return job
}
