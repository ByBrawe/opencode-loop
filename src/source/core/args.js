// Pure Loop command parsing helpers. Keep host/runtime state out of this module.
export const DEFAULT_GOAL_MAX_NO_PROGRESS = 3

export function now() {
  return Date.now()
}

export function safeID(value) {
  return String(value || "job")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "job"
}

export function parseDuration(value) {
  const input = String(value || "").trim()
  if (input === "0") return 0
  const match = input.match(/^(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i)
  if (!match) return null
  const amount = Number.parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  if (!Number.isFinite(amount) || amount < 0) return null
  if (unit === "ms") return amount
  if (unit.startsWith("s")) return amount * 1000
  if (unit.startsWith("m")) return amount * 60_000
  if (unit.startsWith("h")) return amount * 3_600_000
  if (unit.startsWith("d")) return amount * 86_400_000
  return null
}

export function durationToText(ms) {
  if (ms === 0) return "every idle"
  if (!Number.isFinite(ms)) return "unknown"
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

export function splitFirst(input) {
  const match = String(input || "").trim().match(/^(\S+)\s*([\s\S]*)$/)
  if (!match) return ["", ""]
  return [match[1], (match[2] || "").trim()]
}

export function stripOuterQuotes(value) {
  const input = String(value || "").trim()
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) {
    return input.slice(1, -1)
  }
  return input
}

export function escapeRegExp(value) {
  return String(value).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
}

export function takeFlag(rest, flag) {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(flag)}(?=\\s|$)`, "i")
  const found = pattern.test(rest)
  return [found, rest.replace(pattern, " ").replace(/\s+/g, " ").trim()]
}

export function takeFlagValue(rest, flag) {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(flag)}\\s+(?:\"([^\"]*)\"|'([^']*)'|(\\S+))`, "i")
  const match = rest.match(pattern)
  if (!match) return [undefined, rest]
  const value = match[2] ?? match[3] ?? match[4]
  return [value, rest.replace(pattern, " ").replace(/\s+/g, " ").trim()]
}

export function takeAllFlagValues(rest, flag) {
  const values = []
  let current = rest
  while (true) {
    const [value, next] = takeFlagValue(current, flag)
    if (value === undefined) return [values, current]
    values.push(value)
    current = next
  }
}

export function parsePositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || ""), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function parseCompactEvery(value) {
  const duration = parseDuration(value)
  if (duration !== null) return { compactEveryMs: duration }
  const runs = parsePositiveInt(value, 0)
  return runs > 0 ? { compactEveryRuns: runs } : {}
}

export function parseLoopArgs(raw, defaults = {}) {
  let input = stripOuterQuotes(String(raw || "").trim())
  let first = ""
  let rest = input
  let intervalMs = defaults.intervalMs ?? null

  if (!input && defaults.action) {
    rest = defaults.action
  } else {
    ;[first, rest] = splitFirst(input)
    if (first === "--watch") {
      intervalMs = defaults.intervalMs ?? 0
      rest = input
    } else if (first) {
      const parsedDuration = parseDuration(first)
      if (parsedDuration !== null) intervalMs = parsedDuration
      else if (intervalMs === null) return { ok: false, error: "Usage: /loop 0s <prompt> | /loop 5m <prompt> | /loop-goal <objective> | /loop-command 200m /compact | /loop-shell 10m npm test | /loop --watch progress.md <prompt>" }
      else rest = input
    }
  }

  if (intervalMs === null) intervalMs = 0

  const job = {
    id: `${now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
    name: defaults.name,
    action: defaults.action || "",
    kind: defaults.kind || undefined,
    intervalMs,
    immediate: defaults.immediate ?? true,
    maxRuns: defaults.maxRuns ?? 0,
    maxRuntimeMs: defaults.maxRuntimeMs ?? 0,
    maxFailures: defaults.maxFailures ?? 0,
    timeoutMs: defaults.timeoutMs ?? 0,
    until: defaults.until,
    stopFile: defaults.stopFile,
    progressFile: defaults.progressFile,
    promptFile: defaults.promptFile,
    includeFiles: Array.isArray(defaults.includeFiles) ? [...defaults.includeFiles] : [],
    watchPaths: Array.isArray(defaults.watchPaths) ? [...defaults.watchPaths] : [],
    compactEveryRuns: defaults.compactEveryRuns ?? 0,
    compactEveryMs: defaults.compactEveryMs ?? 0,
    testCommand: defaults.testCommand,
    verifyCommand: defaults.verifyCommand,
    preflightCommand: defaults.preflightCommand,
    postrunCommand: defaults.postrunCommand,
    notifyCommand: defaults.notifyCommand,
    branch: defaults.branch,
    branchDone: false,
    goalStatus: defaults.goalStatus,
    goalFile: defaults.goalFile,
    goalAcceptance: Array.isArray(defaults.goalAcceptance) ? [...defaults.goalAcceptance] : [],
    goalChecks: Array.isArray(defaults.goalChecks) ? [...defaults.goalChecks] : [],
    goalCompleteWhenChecksPass: defaults.goalCompleteWhenChecksPass ?? false,
    goalRequireEvidence: defaults.goalRequireEvidence,
    goalRequireChecksPass: defaults.goalRequireChecksPass,
    goalEvidenceFile: defaults.goalEvidenceFile,
    goalSummary: defaults.goalSummary || "",
    goalEvidence: defaults.goalEvidence || "",
    goalBlockedReason: defaults.goalBlockedReason || "",
    goalProgress: Array.isArray(defaults.goalProgress) ? [...defaults.goalProgress] : [],
    maxNoProgress: defaults.maxNoProgress,
    noProgressCount: defaults.noProgressCount ?? 0,
    lastProgressAt: defaults.lastProgressAt ?? 0,
    noOverlap: defaults.noOverlap ?? true,
    safe: defaults.safe ?? false,
    quiet: defaults.quiet ?? false,
    askNever: defaults.askNever ?? false,
    pauseOnVerifyFail: defaults.pauseOnVerifyFail ?? false,
    gitCheckpoint: defaults.gitCheckpoint ?? false,
    checkpointOnly: defaults.checkpointOnly ?? false,
    dryRun: defaults.dryRun ?? false,
    multi: defaults.multi ?? false,
    batch: defaults.batch ?? 0,
    runCount: 0,
    failureCount: 0,
    lastRunAt: 0,
    lastCompactAt: 0,
    lastCompactRunCount: 0,
    watchSnapshot: {},
    watchTriggered: false,
    createdAt: new Date().toISOString(),
    enabled: true,
    paused: false,
  }

  let found
  let value

  ;[found, rest] = takeFlag(rest, "--no-now"); if (found) job.immediate = false
  ;[found, rest] = takeFlag(rest, "--now"); if (found) job.immediate = true
  ;[found, rest] = takeFlag(rest, "--no-overlap"); if (found) job.noOverlap = true
  ;[found, rest] = takeFlag(rest, "--allow-overlap"); if (found) job.noOverlap = false
  ;[found, rest] = takeFlag(rest, "--safe"); if (found) job.safe = true
  ;[found, rest] = takeFlag(rest, "--quiet"); if (found) job.quiet = true
  ;[found, rest] = takeFlag(rest, "--ask-never"); if (found) job.askNever = true
  ;[found, rest] = takeFlag(rest, "--git-checkpoint"); if (found) job.gitCheckpoint = true
  ;[found, rest] = takeFlag(rest, "--checkpoint-only"); if (found) job.checkpointOnly = true
  ;[found, rest] = takeFlag(rest, "--pause-on-verify-fail"); if (found) job.pauseOnVerifyFail = true
  ;[found, rest] = takeFlag(rest, "--dry-run"); if (found) job.dryRun = true
  ;[found, rest] = takeFlag(rest, "--multi"); if (found) job.multi = true
  ;[found, rest] = takeFlag(rest, "--replace"); if (found) job.multi = false
  ;[found, rest] = takeFlag(rest, "--prompt"); if (found) job.kind = "prompt"
  ;[found, rest] = takeFlag(rest, "--ask"); if (found) job.kind = "prompt"
  ;[found, rest] = takeFlag(rest, "--command"); if (found) job.kind = "command"
  ;[found, rest] = takeFlag(rest, "--cmd"); if (found) job.kind = "command"
  ;[found, rest] = takeFlag(rest, "--slash"); if (found) job.kind = "command"
  ;[found, rest] = takeFlag(rest, "--shell"); if (found) job.kind = "shell"
  ;[found, rest] = takeFlag(rest, "--compact"); if (found) job.kind = "compact"
  ;[found, rest] = takeFlag(rest, "--goal"); if (found) job.kind = "goal"
  ;[found, rest] = takeFlag(rest, "--complete-when-checks-pass"); if (found) job.goalCompleteWhenChecksPass = true
  ;[found, rest] = takeFlag(rest, "--no-complete-when-checks-pass"); if (found) job.goalCompleteWhenChecksPass = false
  ;[found, rest] = takeFlag(rest, "--require-evidence"); if (found) job.goalRequireEvidence = true
  ;[found, rest] = takeFlag(rest, "--allow-weak-evidence"); if (found) job.goalRequireEvidence = false
  ;[found, rest] = takeFlag(rest, "--require-checks-pass"); if (found) job.goalRequireChecksPass = true
  ;[found, rest] = takeFlag(rest, "--allow-complete-without-checks"); if (found) job.goalRequireChecksPass = false
  ;[found, rest] = takeFlag(rest, "--allow-complete-with-failing-checks"); if (found) job.goalRequireChecksPass = false

  ;[value, rest] = takeFlagValue(rest, "--name"); if (value !== undefined) job.name = value.trim()
  ;[value, rest] = takeFlagValue(rest, "--max-runs"); if (value !== undefined) job.maxRuns = parsePositiveInt(value, 0)
  ;[value, rest] = takeFlagValue(rest, "--max-turns"); if (value !== undefined) job.maxRuns = parsePositiveInt(value, 0)
  ;[value, rest] = takeFlagValue(rest, "--max-no-progress"); if (value !== undefined) job.maxNoProgress = parseNonNegativeInt(value, DEFAULT_GOAL_MAX_NO_PROGRESS)
  ;[value, rest] = takeFlagValue(rest, "--timeout"); if (value !== undefined) job.timeoutMs = parseDuration(value) ?? 0
  ;[value, rest] = takeFlagValue(rest, "--max-runtime"); if (value !== undefined) job.maxRuntimeMs = parseDuration(value) ?? 0
  ;[value, rest] = takeFlagValue(rest, "--max-failures"); if (value !== undefined) job.maxFailures = parsePositiveInt(value, 0)
  ;[value, rest] = takeFlagValue(rest, "--until"); if (value !== undefined) job.until = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--stop-file"); if (value !== undefined) job.stopFile = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--progress-file"); if (value !== undefined) job.progressFile = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--prompt-file"); if (value !== undefined) job.promptFile = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--goal-file"); if (value !== undefined) job.goalFile = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--evidence-file"); if (value !== undefined) job.goalEvidenceFile = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--test"); if (value !== undefined) job.testCommand = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--verify"); if (value !== undefined) job.verifyCommand = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--preflight"); if (value !== undefined) job.preflightCommand = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--postrun"); if (value !== undefined) job.postrunCommand = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--notify"); if (value !== undefined) job.notifyCommand = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--branch"); if (value !== undefined) job.branch = stripOuterQuotes(value)
  ;[value, rest] = takeFlagValue(rest, "--batch"); if (value !== undefined) job.batch = parsePositiveInt(value, 0)
  ;[value, rest] = takeFlagValue(rest, "--compact-every")
  if (value !== undefined) Object.assign(job, parseCompactEvery(value))

  const watch = takeAllFlagValues(rest, "--watch")
  job.watchPaths.push(...watch[0].map(stripOuterQuotes).filter(Boolean))
  rest = watch[1]

  const includes = takeAllFlagValues(rest, "--include-file")
  job.includeFiles.push(...includes[0].map(stripOuterQuotes).filter(Boolean))
  rest = includes[1]

  const acceptances = takeAllFlagValues(rest, "--acceptance")
  job.goalAcceptance.push(...acceptances[0].map(stripOuterQuotes).filter(Boolean))
  rest = acceptances[1]

  const success = takeAllFlagValues(rest, "--success")
  job.goalAcceptance.push(...success[0].map(stripOuterQuotes).filter(Boolean))
  rest = success[1]

  const checks = takeAllFlagValues(rest, "--check")
  job.goalChecks.push(...checks[0].map(stripOuterQuotes).filter(Boolean))
  rest = checks[1]

  job.action = stripOuterQuotes(rest || job.action || "")
  job.watchPaths = [...new Set(job.watchPaths)]
  job.includeFiles = [...new Set(job.includeFiles)]
  job.goalAcceptance = [...new Set(job.goalAcceptance || [])]
  job.goalChecks = [...new Set(job.goalChecks || [])]
  if (String(job.kind || "").toLowerCase() === "goal") {
    job.name = job.name || "goal"
    job.goalStatus = job.goalStatus || "active"
    job.safe = job.safe !== false
    job.askNever = job.askNever !== false
    job.noOverlap = job.noOverlap !== false
    job.goalRequireEvidence = job.goalRequireEvidence !== false
    job.goalRequireChecksPass = job.goalRequireChecksPass ?? job.goalChecks.length > 0
    job.maxNoProgress = job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS
  }
  job.lastRunAt = job.immediate ? 0 : now()

  if (!job.action && !job.promptFile && !job.goalFile) return { ok: false, error: "Missing action. Example: /loop 0s continue from progress.md, /loop-goal ship the feature, or /loop 0s --prompt-file loop-prompt.md" }
  return { ok: true, job }
}
