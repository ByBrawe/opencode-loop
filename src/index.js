import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { tool } from "@opencode-ai/plugin/tool"

const SERVICE = "opencode-loop"
const STATE_DIR = ".opencode/opencode-loop"
const DEFAULT_ACTIVE_GUARD_MS = 45_000
const STALE_ACTIVE_RECOVERY_MS = 45_000
const IDLE_DEBOUNCE_MS = 1_200
const BUSY_RETRY_MS = 5_000
const SESSION_STATUS_CACHE_MS = 1_500
const MIN_DUE_TIMER_MS = 250
const MAX_DUE_TIMER_MS = 2_147_000_000
const HEARTBEAT_MS = 2_500
const MAX_SCAN_FILES = 200
const MAX_SCAN_BYTES = 2_000_000
const GOAL_REPORT_DIR = "goals"
const GOAL_PROMPT_PREFIX = "EXPERIMENTAL OPENCODE GOAL MODE ITERATION"
const DEFAULT_GOAL_MAX_NO_PROGRESS = 3
const DEFAULT_GOAL_ACTIVE_RECOVERY_MS = 180_000
const LOOP_OWNED_USER_MESSAGE_GUARD_MS = 10_000
const LOOP_OWNED_USER_MESSAGE_RETENTION_MS = 10 * 60_000
const LOCAL_COMMAND_AGENT = "opencode-loop-local"

const activeRuns = new Map()
const handledCommands = new Map()
const handledCommandEvents = new Map()
const sessionExecutionContexts = new Map()
const loopOwnedUserMessageGuards = new Map()
const idleTimers = new Map()
const dueTimers = new Map()
const watchdogTimers = new Map()
const runLocks = new Map()
const knownSessions = new Map()
const stateWriteLocks = new Map()
const activeToolCalls = new Map()
const sessionParents = new Map()
let heartbeatTimer
const sessionStatuses = new Map()
const sessionStatusSeenAt = new Map()
const loopCompactionRequests = new Map()

const DEFAULT_PROGRESS_MD = `# Progress

## Current Goal
Describe the current project goal here.

## Agent Rules
- Do not ask questions unless truly blocked.
- Make reasonable assumptions and continue.
- Work on unfinished TODOs in order.
- Mark completed TODOs with [x].
- Add new bugs, ideas, and follow-up work as TODOs.
- Run tests, lint, or build when available.
- Do not run destructive commands, force pushes, production deploys, or database resets.

## Active TODO
- [ ] Review the project structure and pick the next safe improvement.

## Completed
- [x] Created progress.md.

## Backlog Ideas
- [ ] Add more project-specific tasks here.

## Blocked
- None.
`

function now() {
  return Date.now()
}

function safeID(value) {
  return String(value || "job")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "job"
}

function parseDuration(value) {
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

function durationToText(ms) {
  if (ms === 0) return "every idle"
  if (!Number.isFinite(ms)) return "unknown"
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

function splitFirst(input) {
  const match = String(input || "").trim().match(/^(\S+)\s*([\s\S]*)$/)
  if (!match) return ["", ""]
  return [match[1], (match[2] || "").trim()]
}

function stripOuterQuotes(value) {
  const input = String(value || "").trim()
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) {
    return input.slice(1, -1)
  }
  return input
}

function escapeRegExp(value) {
  return String(value).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
}

function takeFlag(rest, flag) {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(flag)}(?=\\s|$)`, "i")
  const found = pattern.test(rest)
  return [found, rest.replace(pattern, " ").replace(/\s+/g, " ").trim()]
}

function takeFlagValue(rest, flag) {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(flag)}\\s+(?:\"([^\"]*)\"|'([^']*)'|(\\S+))`, "i")
  const match = rest.match(pattern)
  if (!match) return [undefined, rest]
  const value = match[2] ?? match[3] ?? match[4]
  return [value, rest.replace(pattern, " ").replace(/\s+/g, " ").trim()]
}

function takeAllFlagValues(rest, flag) {
  const values = []
  let current = rest
  while (true) {
    const [value, next] = takeFlagValue(current, flag)
    if (value === undefined) return [values, current]
    values.push(value)
    current = next
  }
}

function parsePositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || ""), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function parseCompactEvery(value) {
  const duration = parseDuration(value)
  if (duration !== null) return { compactEveryMs: duration }
  const runs = parsePositiveInt(value, 0)
  return runs > 0 ? { compactEveryRuns: runs } : {}
}

function parseLoopArgs(raw, defaults = {}) {
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

function stateDir(directory) { return path.join(directory, STATE_DIR) }
function statePath(directory, sessionID) { return path.join(stateDir(directory), `${safeID(sessionID)}.json`) }
async function ensureDir(directory) { await fs.mkdir(directory, { recursive: true }) }
async function pathExists(filePath) { try { await fs.access(filePath); return true } catch { return false } }

function stateLockKey(directory, sessionID) {
  return `${path.resolve(directory)}:${safeID(sessionID)}`
}

async function withStateWriteLock(directory, sessionID, fn) {
  const key = stateLockKey(directory, sessionID)
  const previous = stateWriteLocks.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  const next = previous.catch(() => {}).then(() => current)
  stateWriteLocks.set(key, next)
  await previous.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (stateWriteLocks.get(key) === next) stateWriteLocks.delete(key)
  }
}

async function readState(directory, sessionID) {
  const target = statePath(directory, sessionID)
  const attempts = 5
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const parsed = JSON.parse(await fs.readFile(target, "utf8"))
      return { version: 4, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] }
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 4, jobs: [] }
      const transient = error instanceof SyntaxError || isRetriableStateWriteError(error)
      if (!transient || attempt === attempts - 1) break
      await delay(25 * (attempt + 1))
    }
  }
  try {
    await ensureDir(stateDir(directory))
    await fs.copyFile(target, `${target}.corrupt-${Date.now()}`)
  } catch {}
  return { version: 4, jobs: [] }
}

function isRetriableStateWriteError(error) {
  const code = error?.code
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "EEXIST" || code === "EAGAIN"
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// Windows often fails POSIX-style "write temp next to target, then rename over it":
// existing destinations can return EPERM/EEXIST while antivirus, IDE indexers, or
// OpenCode's own snapshotter briefly hold the state file. Temp files next to the
// target also show up in project git snapshots as *.tmp pathspec noise.
//
// Write the payload outside the project first, then replace the target with
// rename when possible and a copy/unlink fallback with short retries.
async function writeFileAtomically(target, contents, options = {}) {
  const encoding = options.encoding || "utf8"
  const attempts = Math.max(1, Number(options.attempts) || 5)
  const temp = path.join(
    os.tmpdir(),
    `opencode-loop-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  )
  await fs.writeFile(temp, contents, encoding)
  try {
    let lastError
    // Prefer an atomic rename and retry transient Windows destination locks
    // before falling back to a non-atomic copy/overwrite.
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await fs.rename(temp, target)
        return
      } catch (error) {
        lastError = error
        if (error?.code === "EXDEV") break
        if (!isRetriableStateWriteError(error)) throw error
        if (attempt < attempts - 1) await delay(25 * (attempt + 1))
      }
    }

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await fs.copyFile(temp, target)
        return
      } catch (error) {
        lastError = error
        if (!isRetriableStateWriteError(error)) throw error
        if (attempt < attempts - 1) await delay(25 * (attempt + 1))
      }
    }

    try {
      await fs.writeFile(target, contents, encoding)
      return
    } catch (error) {
      if (lastError && !error.cause) error.cause = lastError
      throw error
    }
  } finally {
    try { await fs.rm(temp, { force: true }) } catch {}
  }
}

async function writeState(directory, sessionID, state) {
  await withStateWriteLock(directory, sessionID, async () => {
    await ensureDir(stateDir(directory))
    const target = statePath(directory, sessionID)
    const payload = JSON.stringify({ version: 4, jobs: state.jobs || [] }, null, 2)
    await writeFileAtomically(target, payload)
  })
}

async function removeState(directory, sessionID) {
  await withStateWriteLock(directory, sessionID, async () => {
    try { await fs.unlink(statePath(directory, sessionID)) } catch {}
  })
}

function sdkError(result) {
  if (!result || typeof result !== "object") return undefined
  return result.error || result.error === null ? result.error : undefined
}

function sdkData(result) {
  if (!result || typeof result !== "object") return result
  return Object.prototype.hasOwnProperty.call(result, "data") ? result.data : result
}

function sdkErrorMessage(error) {
  if (!error) return "unknown SDK error"
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "object") {
    if (typeof error.message === "string") return error.message
    if (typeof error.name === "string") return error.name
    try { return JSON.stringify(error).slice(0, 400) } catch {}
  }
  return String(error)
}

async function sdkCall(method, ...argsList) {
  let firstError
  for (const args of argsList) {
    if (args === undefined) continue
    try {
      const result = await method(args)
      const error = sdkError(result)
      if (!error) return sdkData(result)
      firstError = firstError || new Error(sdkErrorMessage(error))
    } catch (error) {
      firstError = firstError || error
    }
  }
  throw firstError || new Error("SDK call failed without arguments")
}

function fireSdk(client, label, method, ...argsList) {
  const pending = Promise.resolve().then(() => sdkCall(method, ...argsList))
  void pending.catch((error) => {
    log(client, "warn", `${label} failed`, { error: sdkErrorMessage(error) }).catch(() => {})
  })
  return pending
}

async function executeTuiCommand(client, command) {
  if (!client?.tui?.executeCommand) throw new Error("client.tui.executeCommand is not available")
  return await sdkCall(
    client.tui.executeCommand.bind(client.tui),
    { body: { command } },
    { command },
  )
}

function compactTuiCommandName(command = "compact") {
  const normalized = String(command || "compact").replace(/^\/+/, "").trim().toLowerCase()
  if (normalized === "compact" || normalized === "summarize") return "session_compact"
  return undefined
}

async function readRecentSessionMessages(client, sessionID, directory, limit = 20) {
  if (!client?.session?.messages) return undefined
  const query = { limit }
  if (directory) query.directory = directory
  try {
    const messages = await sdkCall(
      client.session.messages.bind(client.session),
      { path: { id: sessionID }, query },
      { path: { sessionID }, query },
      { sessionID, ...query },
    )
    return Array.isArray(messages) ? messages : undefined
  } catch {
    return undefined
  }
}

function orderedSessionMessages(messages) {
  return (messages || [])
    .map((message, index) => {
      const info = message?.info || message || {}
      const created = Number(info?.time?.created || 0)
      return { message, index, created: Number.isFinite(created) ? created : 0 }
    })
    .sort((a, b) => a.created - b.created || a.index - b.index)
    .map((entry) => entry.message)
}

async function activeRunCompletionFromMessages(directory, client, sessionID, active) {
  const messages = await readRecentSessionMessages(client, sessionID, directory)
  if (!messages) return "unknown"
  const tail = orderedSessionMessages(messages).at(-1)
  const info = tail?.info || tail
  if (!info || info.role !== "assistant") return "incomplete"
  const completed = Number(info?.time?.completed || 0)
  const created = Number(info?.time?.created || 0)
  if (!Number.isFinite(completed) || completed <= 0) return "incomplete"
  const startedAt = Number(active?.startedAt || 0)
  if (startedAt > 0 && completed < startedAt && (!Number.isFinite(created) || created < startedAt)) return "incomplete"
  return "completed"
}

async function resolveCompactionModel(directory, client, sessionID, preferredModel) {
  const preferred = normalizedModelRef(preferredModel)
  if (preferred) return preferred
  const cached = normalizedModelRef(sessionExecutionContexts.get(sessionID)?.model)
  if (cached) return cached
  const captured = await captureSessionExecutionContext(client, sessionID)
  const capturedModel = normalizedModelRef(captured?.model)
  if (capturedModel) return capturedModel
  const messages = await readRecentSessionMessages(client, sessionID, directory)
  for (const message of orderedSessionMessages(messages).reverse()) {
    const info = message?.info || message
    const model = normalizedModelRef(info?.model) || normalizedModelRef(info)
    if (!model) continue
    const previous = sessionExecutionContexts.get(sessionID) || {}
    sessionExecutionContexts.set(sessionID, { ...previous, model })
    return model
  }
  return undefined
}

async function compactSession(directory, client, sessionID, preferredModel) {
  // Prefer the native TUI command when a TUI is present. Headless/server hosts
  // fall back to session.summarize, whose current API requires an explicit
  // provider/model pair.
  for (const command of ["session.compact", "session_compact"]) {
    try {
      await executeTuiCommand(client, command)
      return true
    } catch (error) {
      await log(client, "warn", `tui ${command} failed`, { error: sdkErrorMessage(error) })
    }
  }
  try {
    if (!client?.session?.summarize) throw new Error("client.session.summarize is not available")
    const model = await resolveCompactionModel(directory, client, sessionID, preferredModel)
    if (!model) throw new Error("could not resolve a provider/model for session.summarize")
    const body = { providerID: model.providerID, modelID: model.modelID, auto: false }
    await sdkCall(
      client.session.summarize.bind(client.session),
      { path: { id: sessionID }, body },
      { path: { sessionID }, body },
      { sessionID, ...body },
    )
    return true
  } catch (error) {
    await log(client, "warn", "session.summarize fallback failed", { error: sdkErrorMessage(error) })
  }
  await toast(client, "Could not run /compact from loop. Check OpenCode version and active session model.", "error")
  return false
}

async function log(client, level, message, extra) {
  try {
    await sdkCall(
      client.app.log.bind(client.app),
      { body: extra === undefined ? { service: SERVICE, level, message } : { service: SERVICE, level, message, extra } },
      extra === undefined ? { service: SERVICE, level, message } : { service: SERVICE, level, message, extra },
    )
  } catch {}
}

async function toast(client, message, variant = "info") {
  try { await sdkCall(client.tui.showToast.bind(client.tui), { body: { message, variant } }, { message, variant }) } catch {}
}

function guardLoopOwnedUserMessage(sessionID) {
  if (!sessionID) return
  const current = loopOwnedUserMessageGuards.get(sessionID) || { pending: 0, until: 0, messageIDs: new Map() }
  current.pending += 1
  current.until = Math.max(current.until || 0, now() + LOOP_OWNED_USER_MESSAGE_GUARD_MS)
  for (const [messageID, expiresAt] of current.messageIDs.entries()) if (expiresAt < now()) current.messageIDs.delete(messageID)
  loopOwnedUserMessageGuards.set(sessionID, current)
  for (const [key, entry] of loopOwnedUserMessageGuards.entries()) {
    for (const [messageID, expiresAt] of entry.messageIDs.entries()) if (expiresAt < now()) entry.messageIDs.delete(messageID)
    if ((entry.pending || 0) <= 0 && entry.messageIDs.size === 0 && (entry.until || 0) < now()) loopOwnedUserMessageGuards.delete(key)
  }
}

function loopOwnedUserMessageGuardActive(sessionID, messageID) {
  const entry = loopOwnedUserMessageGuards.get(sessionID)
  if (!entry || typeof entry !== "object") return false
  for (const [id, expiresAt] of entry.messageIDs.entries()) if (expiresAt < now()) entry.messageIDs.delete(id)
  const id = typeof messageID === "string" ? messageID : ""
  if (id && entry.messageIDs.has(id)) return true
  if ((entry.pending || 0) > 0 && (entry.until || 0) >= now()) {
    entry.pending -= 1
    if (id) entry.messageIDs.set(id, now() + LOOP_OWNED_USER_MESSAGE_RETENTION_MS)
    loopOwnedUserMessageGuards.set(sessionID, entry)
    return true
  }
  if ((entry.pending || 0) <= 0 && entry.messageIDs.size === 0) loopOwnedUserMessageGuards.delete(sessionID)
  return false
}

async function say(client, sessionID, text) {
  guardLoopOwnedUserMessage(sessionID)
  try {
    await sdkCall(
      client.session.prompt.bind(client.session),
      { path: { id: sessionID }, body: { noReply: true, parts: [{ type: "text", text }] } },
      { path: { sessionID }, body: { noReply: true, parts: [{ type: "text", text }] } },
      { sessionID, noReply: true, parts: [{ type: "text", text }] },
    )
  } catch {}
}

function commandKey(sessionID, name, args) { return `${sessionID || "no-session"}:${name || ""}:${normalizeArgsForKey(args)}` }
function markHandled(sessionID, name, args) {
  const key = commandKey(sessionID, name, args)
  const previous = handledCommands.get(key)
  const pending = previous && now() - previous.time < 30_000 ? previous.pending + 1 : 1
  handledCommands.set(key, { time: now(), pending })
  for (const [entryKey, entry] of handledCommands.entries()) if (now() - entry.time > 30_000) handledCommands.delete(entryKey)
  for (const [entryKey, time] of handledCommandEvents.entries()) if (now() - time > 30_000) handledCommandEvents.delete(entryKey)
}
function consumeHandled(sessionID, name, args) {
  const key = commandKey(sessionID, name, args)
  const entry = handledCommands.get(key)
  if (!entry || now() - entry.time >= 30_000) {
    handledCommands.delete(key)
    return false
  }
  if (entry.pending <= 1) handledCommands.delete(key)
  else handledCommands.set(key, { time: entry.time, pending: entry.pending - 1 })
  return true
}
function commandEventKey(sessionID, messageID) {
  return `${sessionID || "no-session"}:event:${messageID || "no-message"}`
}

function commandName(name) { return String(name || "") }
function isPreset(name) { return ["loop-dev", "loop-testfix", "loop-compact", "loop-progress", "loop-safe-dev", "loop-command", "loop-cmd", "loop-prompt", "loop-ask", "loop-shell"].includes(name) }
function isLoopCommandName(name) {
  return name === "loop" || name === "loop-stop" || name === "loop-remove" || name === "loop-clear" || name === "loop-status" || name === "loop-logs" || name === "loop-help" || name === "loop-now" || name === "loop-pause" || name === "loop-resume" || name === "loop-doctor" || name === "loop-init" || name === "loop-export" || name === "loop-goal" || name === "loop-goal-status" || name === "loop-goal-pause" || name === "loop-goal-resume" || name === "loop-goal-clear" || name === "loop-goal-done" || name === "loop-goal-complete" || name === "loop-goal-blocked" || isPreset(name)
}

function normalizeArgsForKey(args) {
  if (args === undefined || args === null) return ""
  if (typeof args === "string") return args.trim().replace(/\s+/g, " ")
  if (Array.isArray(args)) return args.map(normalizeArgsForKey).join(" ").trim().replace(/\s+/g, " ")
  try { return JSON.stringify(args) } catch { return String(args) }
}

function commandArgsText(args) {
  if (args === undefined || args === null) return ""
  if (typeof args === "string") return args
  if (Array.isArray(args)) return args.map(commandArgsText).join(" ")
  if (typeof args === "object") {
    for (const key of ["arguments", "args", "message", "text", "value"]) {
      if (args[key] !== undefined) return commandArgsText(args[key])
    }
  }
  return String(args)
}

function rememberSession(directory, client, sessionID) {
  if (!sessionID) return
  knownSessions.set(sessionID, { directory, client, seenAt: now() })
  startHeartbeat()
}

function normalizedModelRef(model) {
  if (typeof model === "string") {
    const separator = model.indexOf("/")
    if (separator > 0) return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
    return undefined
  }
  const providerID = model?.providerID
  const modelID = model?.modelID || model?.id
  if (typeof providerID !== "string" || typeof modelID !== "string") return undefined
  return { providerID, modelID }
}

function updateSessionExecutionContext(info) {
  const sessionID = info?.sessionID || info?.id
  if (typeof sessionID !== "string") return
  const previous = sessionExecutionContexts.get(sessionID) || {}
  const candidateAgent = info?.agent || (info?.role === "assistant" ? info?.mode : undefined)
  const agent = typeof candidateAgent === "string" && candidateAgent !== LOCAL_COMMAND_AGENT
    ? candidateAgent
    : previous.agent
  const model = normalizedModelRef(info?.model) || normalizedModelRef(info) || previous.model
  sessionExecutionContexts.set(sessionID, { agent, model })
}

async function captureSessionExecutionContext(client, sessionID) {
  if (client?.session?.get) {
    try {
      const info = await sdkCall(
        client.session.get.bind(client.session),
        { path: { id: sessionID } },
        { path: { sessionID } },
        { sessionID },
      )
      updateSessionExecutionContext(info)
    } catch {}
  }
  const context = sessionExecutionContexts.get(sessionID) || {}
  const normalized = { agent: context.agent || "build", model: context.model }
  sessionExecutionContexts.set(sessionID, normalized)
  return normalized
}

function hasActiveToolCalls(sessionID) {
  return (activeToolCalls.get(sessionID)?.size || 0) > 0
}

function markToolCallActive(input) {
  const sessionID = input?.sessionID
  const callID = input?.callID
  if (typeof sessionID !== "string" || typeof callID !== "string") return
  const calls = activeToolCalls.get(sessionID) || new Set()
  calls.add(callID)
  activeToolCalls.set(sessionID, calls)
  sessionStatuses.set(sessionID, "busy")
  sessionStatusSeenAt.set(sessionID, now())
}

function markToolCallFinished(input) {
  const sessionID = input?.sessionID
  const callID = input?.callID
  if (typeof sessionID !== "string" || typeof callID !== "string") return
  const calls = activeToolCalls.get(sessionID)
  if (!calls) return
  calls.delete(callID)
  if (!calls.size) activeToolCalls.delete(sessionID)
}

function updateSessionRelationship(info, removed = false) {
  const sessionID = info?.id
  if (typeof sessionID !== "string") return
  if (removed || typeof info?.parentID !== "string") sessionParents.delete(sessionID)
  else sessionParents.set(sessionID, info.parentID)
  if (!removed) updateSessionExecutionContext(info)
  else sessionExecutionContexts.delete(sessionID)
}

function updateSessionRelationshipFromEvent(event) {
  if (!["session.created", "session.updated", "session.deleted"].includes(event?.type)) return
  updateSessionRelationship(event?.properties?.info, event.type === "session.deleted")
}

function isDescendantSession(sessionID, ancestorID) {
  const visited = new Set()
  let current = sessionID
  while (sessionParents.has(current) && !visited.has(current)) {
    visited.add(current)
    current = sessionParents.get(current)
    if (current === ancestorID) return true
  }
  return false
}

function hasBusyDescendant(sessionID) {
  for (const childID of sessionParents.keys()) {
    if (!isDescendantSession(childID, sessionID)) continue
    const status = sessionStatuses.get(childID)
    if (status === "busy" || status === "retry" || hasActiveToolCalls(childID)) return true
  }
  return false
}

async function refreshSessionRelationships(client, directory) {
  if (!client?.session?.list) return
  try {
    const sessions = await sdkCall(
      client.session.list.bind(client.session),
      { query: { directory } },
      { directory },
      {},
    )
    if (Array.isArray(sessions)) for (const info of sessions) updateSessionRelationship(info)
  } catch {}
}

function updateToolActivityFromEvent(event) {
  const props = event?.properties || {}
  if (event?.type === "message.part.updated") {
    const part = props.part
    if (part?.type !== "tool") return
    const sessionID = part.sessionID || props.sessionID
    if (["pending", "running"].includes(part.state?.status)) {
      markToolCallActive({ sessionID, callID: part.callID })
    }
    if (["completed", "error"].includes(part.state?.status)) {
      // Task/subagent hooks have used the part id as their hook call id in some
      // OpenCode versions, while normal tools use part.callID. Clear either.
      const identifiers = [...new Set([part.callID, part.id].filter((value) => typeof value === "string"))]
      for (const callID of identifiers) markToolCallFinished({ sessionID, callID })
    }
    return
  }

  const started = ["session.next.shell.started", "session.next.tool.called"].includes(event?.type)
  const finished = ["session.next.shell.ended", "session.next.tool.success", "session.next.tool.failed"].includes(event?.type)
  if (started) markToolCallActive(props)
  if (finished) markToolCallFinished(props)
}

function startHeartbeat() {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    for (const [sessionID, info] of [...knownSessions.entries()]) {
      if (!info || now() - (info.seenAt || 0) > 12 * 60 * 60 * 1000) {
        knownSessions.delete(sessionID)
        continue
      }
      Promise.resolve()
        .then(async () => {
          await finalizeActiveRun(info.directory, info.client, sessionID, { requireIdle: true, forceStale: true })
          await maybeRunDueJobs(info.directory, info.client, sessionID, { heartbeat: true })
        })
        .catch((error) => appendLoopLog(info.directory, "heartbeat-error", { sessionID, error: sdkErrorMessage(error) }).catch(() => {}))
    }
    if (!knownSessions.size && heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
  }, HEARTBEAT_MS)
}

function disposeRuntime(directory, client) {
  const sessions = [...knownSessions.entries()]
    .filter(([, info]) => info?.directory === directory && info?.client === client)
    .map(([sessionID]) => sessionID)
  for (const sessionID of sessions) {
    clearActiveRun(sessionID)
    const idle = idleTimers.get(sessionID); if (idle) clearTimeout(idle)
    const due = dueTimers.get(sessionID); if (due) clearTimeout(due)
    const watchdog = watchdogTimers.get(sessionID); if (watchdog) clearInterval(watchdog)
    idleTimers.delete(sessionID)
    dueTimers.delete(sessionID)
    watchdogTimers.delete(sessionID)
    runLocks.delete(sessionID)
    knownSessions.delete(sessionID)
    loopOwnedUserMessageGuards.delete(sessionID)
    activeToolCalls.delete(sessionID)
    sessionParents.delete(sessionID)
    sessionStatuses.delete(sessionID)
    sessionStatusSeenAt.delete(sessionID)
    sessionExecutionContexts.delete(sessionID)
    loopCompactionRequests.delete(sessionID)
    for (const key of handledCommands.keys()) if (key.startsWith(`${sessionID}:`)) handledCommands.delete(key)
    for (const key of handledCommandEvents.keys()) if (key.startsWith(`${sessionID}:`)) handledCommandEvents.delete(key)
  }
  if (!knownSessions.size && heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }
}

function presetDefaults(name) {
  // parseLoopArgs owns duration/flag/action parsing. Presets only provide real
  // defaults; deriving an action from the raw string made flag-only invocations
  // such as `/loop-compact --dry-run` use "--dry-run" as the action.
  if (name === "loop-compact") return { intervalMs: parseDuration("200m"), action: "/compact", kind: "compact", name: "compact", immediate: false }
  if (name === "loop-command" || name === "loop-cmd") return { intervalMs: 0, kind: "command", name: "command", immediate: false }
  if (name === "loop-prompt") return { intervalMs: 0, kind: "prompt", name: "prompt", immediate: true }
  if (name === "loop-ask") return { intervalMs: 0, kind: "prompt", name: "ask", immediate: false }
  if (name === "loop-shell") return { intervalMs: 0, kind: "shell", name: "shell", immediate: false }
  if (name === "loop-testfix") return { intervalMs: 0, name: "testfix", safe: true, askNever: true, verifyCommand: "npm test", testfixPreset: true, action: "Run the project tests. Fix failures. Re-run the tests. Test command hint: npm test" }
  if (name === "loop-progress") return { intervalMs: 0, name: "progress", safe: true, askNever: true, progressFile: "progress.md", action: "Read progress.md and continue the next unfinished TODO. Mark completed TODOs with [x]. Add useful TODOs when you discover them." }
  if (name === "loop-safe-dev") return { intervalMs: 0, name: "safe-dev", safe: true, askNever: true, noOverlap: true, checkpointOnly: true, batch: 5, progressFile: "progress.md", action: "Develop the project from progress.md. Work in small safe batches. Mark completed TODOs with [x]. Add new ideas to progress.md. Run tests/lint/build if available." }
  return { intervalMs: 0, name: "dev", askNever: true, progressFile: "progress.md", action: "Continue developing the project from progress.md. Mark completed TODOs with [x]. Add new ideas to progress.md. Run tests/lint/build if available." }
}

function jobLabel(job) {
  const title = job.name ? `${job.name}: ` : ""
  const kind = job.kind ? ` [${job.kind}]` : ""
  const limit = job.maxRuns > 0 ? `, max ${job.maxRuns}` : ""
  const runtime = job.maxRuntimeMs > 0 ? `, runtime ${durationToText(job.maxRuntimeMs)}` : ""
  const timeout = job.timeoutMs > 0 ? `, timeout ${durationToText(job.timeoutMs)}` : ""
  const compact = job.compactEveryRuns > 0 ? `, compact every ${job.compactEveryRuns} runs` : job.compactEveryMs > 0 ? `, compact every ${durationToText(job.compactEveryMs)}` : ""
  const verify = job.verifyCommand ? ", verify" : ""
  const preflight = job.preflightCommand ? ", preflight" : ""
  const failures = job.maxFailures > 0 ? `, max failures ${job.maxFailures}` : ""
  const noProgress = isGoalJob(job) && (job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS) > 0 ? `, max no-progress ${job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS}` : ""
  const stopFile = job.stopFile ? ", stop-file" : ""
  const watch = job.watchPaths?.length ? `, watch ${job.watchPaths.join(",")}` : ""
  const paused = job.paused ? ", paused" : ""
  return `${title}${durationToText(job.intervalMs)}${kind} -> ${job.action || `[prompt-file: ${job.promptFile}]`}${limit}${runtime}${timeout}${compact}${verify}${preflight}${failures}${noProgress}${stopFile}${watch}${paused}`
}

function matchJob(job, target, index) {
  const text = String(target || "").trim()
  if (!text || text.toLowerCase() === "all") return true
  return job.id === text || job.name === text || String(index + 1) === text
}

async function appendLoopLog(directory, line, extra = {}) {
  try {
    await ensureDir(stateDir(directory))
    await fs.appendFile(path.join(stateDir(directory), "loop.log"), JSON.stringify({ time: new Date().toISOString(), line, ...extra }) + "\n")
  } catch {}
}

async function readSmallTextFile(filePath, maxBytes = 120_000) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size > maxBytes) return ""
    return await fs.readFile(filePath, "utf8")
  } catch { return "" }
}

async function runProcess(command, args, cwd, timeoutMs = 60_000) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true })
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => { try { child.kill("SIGTERM") } catch {} }, timeoutMs)
    child.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
    child.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stdout: "", stderr: String(error) }) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }) })
  })
}

async function runShellCommand(command, cwd, timeoutMs = 120_000) {
  return await new Promise((resolve) => {
    const child = spawn(command, [], { cwd, shell: true, windowsHide: true })
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => { try { child.kill("SIGTERM") } catch {} }, timeoutMs)
    child.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
    child.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stdout: "", stderr: String(error) }) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }) })
  })
}

async function notifyJob(directory, job, reason) {
  if (!job.notifyCommand) return
  const command = String(job.notifyCommand).replace(/\{reason\}/g, String(reason || "")).replace(/\{job\}/g, String(job.name || job.id || ""))
  await runShellCommand(command, directory, 60_000)
}

function dangerousShell(command) {
  const text = String(command || "").toLowerCase()
  return [
    /\brm\b(?=[^\r\n]*\s-{1,2}(?:[a-z]*r[a-z]*|recursive)\b)(?=[^\r\n]*\s-{1,2}(?:[a-z]*f[a-z]*|force)\b)/,
    /\bremove-item\b[^\r\n]*(?:-recurse|-force)/,
    /\bgit\s+reset\b/,
    /\bgit\s+clean\b/,
    /\bgit\s+push\b/,
    /\bdel\b[^\r\n]*\s\/s\b/,
    /\b(?:rmdir|rd)\b[^\r\n]*\s\/s\b/,
    /(?:^|[;&|]\s*)format(?:\.com)?\s+(?:[a-z]:|\/(?:fs|q)\b)/,
    /\bterraform\s+destroy\b/,
    /\bkubectl\s+delete\b/,
    /\bdeploy\b.*\bproduction\b/,
  ].some((pattern) => pattern.test(text))
}

function actionKind(action, job = {}) {
  const text = String(action || "").trim()
  const forced = String(job.kind || "").trim().toLowerCase()
  if (forced === "compact") return "compact"
  if (forced === "goal") return "goal"
  if (text === "/compact" || text === "/summarize") return "compact"
  if (forced === "prompt" || forced === "ask") return "prompt"
  if (forced === "command" || forced === "cmd" || forced === "slash") return "command"
  if (forced === "shell") return "shell"
  if (text.startsWith("/")) return "command"
  if (text.startsWith("!") || text.startsWith("$")) return "shell"
  return "prompt"
}

function decoratePrompt(job) {
  const additions = []
  if (job.progressFile) additions.push(`Use ${job.progressFile} as the main progress/TODO state file. Read it before choosing the next task and update it after work.`)
  if (job.lastVerifyFailure) additions.push("Previous verify command failed. Fix this before moving on. Failure summary: " + String(job.lastVerifyFailure).slice(0, 1200))
  if (job.askNever) additions.push("Do not ask the user questions. Make reasonable assumptions and continue. Only write a short BLOCKED note if truly blocked.")
  if (job.safe) additions.push("Safety rules: do not run destructive commands such as git reset, git clean, rm -rf, del /s, rmdir /s, force push, production deploys, production migrations, terraform destroy, or deleting user data. If such an action seems needed, write a BLOCKED note instead.")
  if (job.batch > 0) additions.push(`Batch rule: in this run, work on at most ${job.batch} unfinished TODO item(s). Mark completed items with [x].`)
  if (job.quiet) additions.push("Keep replies short. Summarize only what changed, tests run, and next step.")
  if (job.testCommand) additions.push(`After making changes, run this test/check command if applicable: ${job.testCommand}. If it fails, fix the failure and try again.`)
  if (job.checkpointOnly || job.gitCheckpoint) additions.push("Keep changes incremental and easy to review because the loop will create a checkpoint after the run.")
  if (!additions.length) return job.action
  return `${job.action}\n\nOpenCode loop instructions:\n- ${additions.join("\n- ")}`
}

function isGoalJob(job) {
  return String(job?.kind || "").toLowerCase() === "goal"
}

function goalStatusText(job) {
  const status = job?.goalStatus || (isGoalJob(job) ? "active" : "")
  if (!status) return ""
  if (status === "completed") return "completed"
  if (status === "blocked") return "blocked"
  if (job?.paused) return "paused"
  return status
}

async function buildGoalPrompt(directory, job) {
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

async function buildPrompt(directory, job) {
  if (isGoalJob(job)) return await buildGoalPrompt(directory, job)
  const sections = []
  if (job.promptFile) {
    const text = await readSmallTextFile(path.resolve(directory, job.promptFile))
    if (text.trim()) sections.push(`Instructions from ${job.promptFile}:\n${text.trim()}`)
    else sections.push(`Prompt file ${job.promptFile} was requested but could not be read. Continue from the regular action instead.`)
  }
  if (job.action) sections.push(decoratePrompt(job))
  for (const file of job.includeFiles || []) {
    const text = await readSmallTextFile(path.resolve(directory, file), 80_000)
    if (text.trim()) sections.push(`Context from ${file}:\n${text.trim().slice(0, 20_000)}`)
  }
  return sections.join("\n\n---\n\n") || decoratePrompt(job)
}

async function ensureBranch(directory, job, client, sessionID) {
  if (!job.branch || job.branchDone) return job
  const branch = safeID(job.branch)
  const inRepo = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], directory, 10_000)
  if (inRepo.code !== 0) { job.branchDone = true; return job }
  let result = await runProcess("git", ["switch", branch], directory, 30_000)
  if (result.code !== 0) result = await runProcess("git", ["switch", "-c", branch], directory, 30_000)
  job.branchDone = true
  await toast(client, result.code === 0 ? `Loop branch active: ${branch}` : `Could not switch/create branch: ${branch}`, result.code === 0 ? "success" : "warning")
  await appendLoopLog(directory, "branch", { sessionID, branch, code: result.code })
  return job
}

async function maybeCompact(directory, client, sessionID, job) {
  const dueRuns = job.compactEveryRuns > 0 && (job.runCount || 0) > 0 && (job.runCount || 0) % job.compactEveryRuns === 0 && job.lastCompactRunCount !== job.runCount
  const dueTime = job.compactEveryMs > 0 && (!job.lastCompactAt || now() - job.lastCompactAt >= job.compactEveryMs)
  if (!dueRuns && !dueTime) return { job, started: false }
  beginLoopCompaction(sessionID, job.id, true)
  if (await compactSession(directory, client, sessionID, job.model)) {
    job.lastCompactAt = now()
    job.lastCompactRunCount = job.runCount || 0
    return { job, started: true }
  }
  loopCompactionRequests.delete(sessionID)
  return { job, started: false }
}

async function snapshotPaths(directory, files) {
  const snapshot = {}
  for (const file of files || []) {
    try {
      const stat = await fs.stat(path.resolve(directory, file))
      snapshot[file] = `${stat.mtimeMs}:${stat.size}`
    } catch { snapshot[file] = "missing" }
  }
  return snapshot
}

async function watchChanged(directory, job) {
  if (!job.watchPaths?.length) return false
  const next = await snapshotPaths(directory, job.watchPaths)
  const previous = job.watchSnapshot || {}
  const changed = job.watchPaths.some((file) => previous[file] !== next[file])
  if (changed) job.watchSnapshot = next
  return changed
}

async function fileContains(filePath, needle) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return false
    return (await fs.readFile(filePath, "utf8")).includes(needle)
  } catch { return false }
}

async function untilReached(directory, job) {
  if (!job.until) return false
  const files = ["progress.md", "PROGRESS.md", "todo.md", "TODO.md", "todolist.md", "TODOLIST.md", path.join(".opencode", "opencode-loop", "until.txt")]
  for (const file of files) if (await fileContains(path.resolve(directory, file), job.until)) return true
  let scanned = 0
  async function walk(current) {
    if (scanned >= MAX_SCAN_FILES) return false
    let entries
    try { entries = await fs.readdir(current, { withFileTypes: true }) } catch { return false }
    for (const entry of entries) {
      if (scanned >= MAX_SCAN_FILES) return false
      if ([".git", "node_modules", "dist", "build", ".next", "coverage"].includes(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { if (await walk(full)) return true }
      else if (entry.isFile() && /\.(md|txt|json|yaml|yml)$/i.test(entry.name)) { scanned++; if (await fileContains(full, job.until)) return true }
    }
    return false
  }
  return await walk(directory)
}

async function createCheckpoint(directory, sessionID, job, client) {
  if (!job.checkpointOnly && !job.gitCheckpoint) return
  const inRepo = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], directory, 10_000)
  if (inRepo.code !== 0) return
  const status = await runProcess("git", ["status", "--short"], directory, 30_000)
  if (!status.stdout.trim()) return
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const checkpointDir = path.join(stateDir(directory), "checkpoints", safeID(sessionID))
  await ensureDir(checkpointDir)
  const diff = await runProcess("git", ["diff", "--binary"], directory, 120_000)
  const staged = await runProcess("git", ["diff", "--cached", "--binary"], directory, 120_000)
  const prefix = `${timestamp}-${safeID(job.name || job.id)}`
  await fs.writeFile(path.join(checkpointDir, `${prefix}.status.txt`), status.stdout + status.stderr)
  await fs.writeFile(path.join(checkpointDir, `${prefix}.patch`), `${diff.stdout}\n${staged.stdout}`)
  if (job.gitCheckpoint) {
    await runProcess("git", ["add", "-A"], directory, 120_000)
    await runProcess("git", ["commit", "-m", `chore: opencode loop checkpoint ${timestamp}`], directory, 120_000)
  }
  await toast(client, `Loop checkpoint saved: ${prefix}`, "success")
}

function updateSessionStatusFromEvent(event) {
  const sessionID = event?.properties?.sessionID
  if (typeof sessionID !== "string") return undefined
  if (event?.type === "session.idle") {
    sessionStatuses.set(sessionID, "idle")
    sessionStatusSeenAt.set(sessionID, now())
    return { sessionID, idle: true }
  }
  if (event?.type === "session.status") {
    const status = event?.properties?.status
    const type = status && typeof status === "object" ? status.type : undefined
    if (typeof type === "string") {
      sessionStatuses.set(sessionID, type)
      sessionStatusSeenAt.set(sessionID, now())
    }
    return { sessionID, idle: type === "idle" }
  }
  return undefined
}

function userInterruptSessionFromEvent(event) {
  if (!["message.updated", "message.created"].includes(String(event?.type || ""))) return undefined
  const props = event?.properties || {}
  const info = props.info || props.message || props
  const role = info?.role
  const sessionID = info?.sessionID || props.sessionID
  const messageID = info?.id || props.messageID
  if (role !== "user" || typeof sessionID !== "string") return undefined
  if (loopOwnedUserMessageGuardActive(sessionID, messageID)) return undefined
  return sessionID
}

async function pauseGoalsForUserInterrupt(directory, client, sessionID) {
  const state = await readState(directory, sessionID)
  const interruptedAt = now()
  let count = 0
  state.jobs = (state.jobs || []).map((job) => {
    if (!isGoalJob(job) || job.paused || job.enabled === false || ["completed", "blocked", "cleared"].includes(job.goalStatus)) return job
    count++
    return {
      ...job,
      paused: true,
      lastUserInterruptAt: interruptedAt,
      goalInterruptedReason: "Paused because the user sent a new message while the experimental goal was active.",
    }
  })
  if (!count) return false
  await writeState(directory, sessionID, state)
  await toast(client, `Paused ${count} experimental goal(s) because a new user message arrived. Resume with /loop-goal-resume.`, "warning")
  await appendLoopLog(directory, "goal-user-interrupt", { sessionID, count })
  await scheduleDueWork(directory, client, sessionID)
  return true
}

function staleActiveRun(sessionID) {
  const active = activeRuns.get(sessionID)
  if (!active) return false
  const age = now() - (active.startedAt || 0)
  const configured = Number(active.job?.staleActiveRecoveryMs || active.job?.activeRecoveryMs || 0)
  const threshold = Number.isFinite(configured) && configured > 0 ? configured : STALE_ACTIVE_RECOVERY_MS
  return age >= threshold
}

async function canFinalizeActiveRun(directory, client, sessionID, active, options = {}) {
  if (hasActiveToolCalls(sessionID) || hasBusyDescendant(sessionID)) return false
  if (!options.requireIdle && !options.forceStale) return true

  const completion = options.forceStale
    ? await activeRunCompletionFromMessages(directory, client, sessionID, active)
    : undefined
  if (completion === "completed") return true
  if (!options.requireIdle) return completion === "unknown" && staleActiveRun(sessionID)

  const live = await readLiveSessionStatus(client, sessionID, directory)
  if (live?.type === "idle") return true
  if (live?.type) {
    if ((live.type === "busy" || live.type === "retry") && options.forceStale && completion === "unknown" && staleActiveRun(sessionID)) return true
    return false
  }

  if (options.forceStale && completion === "unknown" && staleActiveRun(sessionID)) return true
  const cached = sessionStatuses.get(sessionID)
  const seenAt = sessionStatusSeenAt.get(sessionID) || 0
  return cached === "idle" && seenAt > (active.startedAt || 0)
}

async function readLiveSessionStatus(client, sessionID, directory) {
  const argsList = []
  if (directory) argsList.push({ query: { directory } }, { directory }, { workspace: directory })
  argsList.push({})
  for (const args of argsList) {
    try {
      const result = await client.session.status(args)
      const error = sdkError(result)
      if (error) continue
      const data = sdkData(result)
      if (!data || typeof data !== "object" || Array.isArray(data)) continue
      const observedAt = now()
      for (const [observedSessionID, observedStatus] of Object.entries(data)) {
        const observedType = observedStatus && typeof observedStatus === "object" ? observedStatus.type : undefined
        if (typeof observedType !== "string") continue
        sessionStatuses.set(observedSessionID, observedType)
        sessionStatusSeenAt.set(observedSessionID, observedAt)
      }
      // OpenCode's status list contains active sessions; idle sessions are
      // normally omitted. Clear a completed descendant that was previously busy.
      for (const childID of sessionParents.keys()) {
        if (!isDescendantSession(childID, sessionID) || data[childID]) continue
        sessionStatuses.set(childID, "idle")
        sessionStatusSeenAt.set(childID, observedAt)
      }
      if (hasBusyDescendant(sessionID)) return { type: "busy", source: "descendant" }
      const status = data?.[sessionID]
      const type = status && typeof status === "object" ? status.type : undefined
      if (typeof type === "string") return { type, source: "sdk" }
      return { type: "idle", source: "sdk" }
    } catch {}
  }
  return undefined
}

async function sessionStatusType(client, sessionID, directory, options = {}) {
  // OpenCode can briefly report an idle session while a long-running tool or
  // subtask is still executing. Tool lifecycle hooks are the more specific
  // signal here, so never enqueue another turn until every active call ends.
  if (hasActiveToolCalls(sessionID) || hasBusyDescendant(sessionID)) {
    sessionStatuses.set(sessionID, "busy")
    sessionStatusSeenAt.set(sessionID, now())
    return "busy"
  }

  const cached = sessionStatuses.get(sessionID)
  const seenAt = sessionStatusSeenAt.get(sessionID) || 0

  // Idle is safe to trust until OpenCode tells us otherwise. Busy/retry is only
  // trusted briefly: OpenCode custom commands such as /loop-status create their
  // own short assistant turn, and some TUI builds do not always emit the final
  // idle event after that turn. If we cache busy forever, due loop work can get
  // stuck at "due in every idle" until the user types another command.
  if (cached === "idle") return cached
  if (cached && now() - seenAt < SESSION_STATUS_CACHE_MS) return cached

  const live = await readLiveSessionStatus(client, sessionID, directory)
  if (live?.type) {
    // Some OpenCode 1.15.x TUI builds can leave session.status at busy after a
    // plugin-injected turn until the next user command touches the session.
    // When the only reason we still think the session is busy is our own stale
    // active-run guard, recover instead of waiting for another manual command.
    if ((live.type === "busy" || live.type === "retry") && options.recoverStaleActive !== false) {
      const active = activeRuns.get(sessionID)
      if (active) {
        const completion = await activeRunCompletionFromMessages(directory, client, sessionID, active)
        if (completion === "completed" || (completion === "unknown" && staleActiveRun(sessionID))) {
          sessionStatuses.set(sessionID, "idle")
          sessionStatusSeenAt.set(sessionID, now())
          await appendLoopLog(directory, completion === "completed" ? "status-message-complete-recovery" : "status-stale-recovery", {
            sessionID,
            job: active.job?.name || active.jobId,
            startedAt: active.startedAt,
          })
          return "idle"
        }
      }
    }
    sessionStatuses.set(sessionID, live.type)
    sessionStatusSeenAt.set(sessionID, now())
    return live.type
  }

  const fallback = activeRuns.has(sessionID) && !staleActiveRun(sessionID) ? "busy" : "idle"
  sessionStatuses.set(sessionID, fallback)
  sessionStatusSeenAt.set(sessionID, now())
  return fallback
}

async function sessionIsIdle(client, sessionID, directory, options = {}) {
  return await sessionStatusType(client, sessionID, directory, options) === "idle"
}

function scheduleIdleWork(directory, client, sessionID) {
  const previous = idleTimers.get(sessionID)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    idleTimers.delete(sessionID)
    Promise.resolve()
      .then(async () => {
        if (!await sessionIsIdle(client, sessionID, directory)) {
          await scheduleDueWork(directory, client, sessionID, BUSY_RETRY_MS)
          return
        }
        await finalizeActiveRun(directory, client, sessionID)
        if (!await sessionIsIdle(client, sessionID, directory)) {
          await scheduleDueWork(directory, client, sessionID, BUSY_RETRY_MS)
          return
        }
        await maybeRunDueJobs(directory, client, sessionID)
      })
      .catch((error) => {
        toast(client, `Loop idle handler failed: ${sdkErrorMessage(error)}`, "error").catch(() => {})
        appendLoopLog(directory, "idle-error", { sessionID, error: sdkErrorMessage(error) }).catch(() => {})
      })
  }, IDLE_DEBOUNCE_MS)
  idleTimers.set(sessionID, timer)
}

function jobDueAt(job, current = now()) {
  if (isGoalJob(job) && ["completed", "blocked", "cleared"].includes(job.goalStatus)) return Infinity
  if (!job.enabled || job.paused) return Infinity
  if (job.maxRuns > 0 && (job.runCount || 0) >= job.maxRuns) return Infinity
  if (job.watchPaths?.length) return Infinity
  const created = Date.parse(job.createdAt || new Date().toISOString())
  if (job.maxRuntimeMs > 0 && current - created >= job.maxRuntimeMs) return current
  if (job.intervalMs === 0) return current
  if (!job.lastRunAt) return current
  return job.lastRunAt + (job.intervalMs || 0)
}

function nextDueDelay(state) {
  const current = now()
  let soonest = Infinity
  for (const job of state.jobs || []) soonest = Math.min(soonest, jobDueAt(job, current))
  if (!Number.isFinite(soonest)) return Infinity
  return Math.max(0, soonest - current)
}

async function startWatchdog(directory, client, sessionID) {
  if (watchdogTimers.has(sessionID)) return
  const timer = setInterval(() => {
    Promise.resolve()
      .then(async () => {
        const state = await readState(directory, sessionID)
        const delay = nextDueDelay(state)
        const hasJobs = (state.jobs || []).some((job) => job.enabled !== false && !job.paused && (!isGoalJob(job) || !["completed", "blocked", "cleared"].includes(job.goalStatus)))
        if (!hasJobs || !Number.isFinite(delay)) {
          const existing = watchdogTimers.get(sessionID)
          if (existing) clearInterval(existing)
          watchdogTimers.delete(sessionID)
          return
        }
        if (delay <= 0) await maybeRunDueJobs(directory, client, sessionID)
        else await scheduleDueWork(directory, client, sessionID)
      })
      .catch((error) => appendLoopLog(directory, "watchdog-error", { sessionID, error: sdkErrorMessage(error) }).catch(() => {}))
  }, Math.max(1_000, BUSY_RETRY_MS))
  // Keep this interval referenced. In current OpenCode TUI builds, plugin hooks
  // are event-driven; a referenced watchdog helps scheduled loops wake up even
  // when no manual /loop-status command is typed.
  watchdogTimers.set(sessionID, timer)
}

function stopWatchdog(sessionID) {
  const timer = watchdogTimers.get(sessionID)
  if (timer) clearInterval(timer)
  watchdogTimers.delete(sessionID)
}

async function scheduleDueWork(directory, client, sessionID, minDelayMs = 0) {
  const previous = dueTimers.get(sessionID)
  if (previous) clearTimeout(previous)

  const state = await readState(directory, sessionID)
  const delay = nextDueDelay(state)
  if (!Number.isFinite(delay)) {
    dueTimers.delete(sessionID)
    return
  }

  const wait = Math.min(Math.max(delay, minDelayMs, MIN_DUE_TIMER_MS), MAX_DUE_TIMER_MS)
  const timer = setTimeout(() => {
    dueTimers.delete(sessionID)
    Promise.resolve()
      .then(async () => {
        if (!await sessionIsIdle(client, sessionID, directory)) {
          await scheduleDueWork(directory, client, sessionID, BUSY_RETRY_MS)
          return
        }
        await finalizeActiveRun(directory, client, sessionID)
        if (!await sessionIsIdle(client, sessionID, directory)) {
          await scheduleDueWork(directory, client, sessionID, BUSY_RETRY_MS)
          return
        }
        await maybeRunDueJobs(directory, client, sessionID)
      })
      .catch((error) => {
        toast(client, `Loop due timer failed: ${sdkErrorMessage(error)}`, "error").catch(() => {})
        appendLoopLog(directory, "due-timer-error", { sessionID, error: sdkErrorMessage(error) }).catch(() => {})
      })
  }, wait)
  dueTimers.set(sessionID, timer)
  await startWatchdog(directory, client, sessionID)
}

function dueJobs(state, force = false) {
  const current = now()
  return (state.jobs || []).filter((job) => {
    if (isGoalJob(job) && ["completed", "blocked", "cleared"].includes(job.goalStatus)) return false
    if (!job.enabled || job.paused) return false
    if (job.maxRuns > 0 && (job.runCount || 0) >= job.maxRuns) return false
    if (job.maxRuntimeMs > 0 && current - Date.parse(job.createdAt || new Date().toISOString()) >= job.maxRuntimeMs) return true
    if (force) return true
    if (job.watchPaths?.length) return job.watchTriggered === true
    return job.intervalMs === 0 || !job.lastRunAt || current - job.lastRunAt >= job.intervalMs
  })
}

function clearActiveRun(sessionID) {
  const active = activeRuns.get(sessionID)
  if (active?.timer) clearTimeout(active.timer)
  const compact = loopCompactionRequests.get(sessionID)
  if (!compact || !active || compact.jobId === active.jobId) loopCompactionRequests.delete(sessionID)
  activeRuns.delete(sessionID)
}

function beginLoopCompaction(sessionID, jobId, resumeAfter = false) {
  loopCompactionRequests.set(sessionID, {
    jobId,
    resumeAfter,
    requestedAt: now(),
    startedAt: 0,
    completedAt: 0,
  })
}

async function noteLoopCompactionStarted(directory, sessionID) {
  const pending = loopCompactionRequests.get(sessionID)
  if (!pending) return false
  if (!pending.startedAt) {
    pending.startedAt = now()
    loopCompactionRequests.set(sessionID, pending)
    await appendLoopLog(directory, "compact-started", { sessionID, job: pending.jobId, resumeAfter: pending.resumeAfter })
  }
  return true
}

async function finalizeLoopCompaction(directory, client, sessionID) {
  const pending = loopCompactionRequests.get(sessionID)
  const active = activeRuns.get(sessionID)
  if (!pending || !active || pending.jobId !== active.jobId) return false
  return await finalizeActiveRun(directory, client, sessionID)
}

async function noteLoopCompactionCompleted(directory, client, sessionID) {
  const pending = loopCompactionRequests.get(sessionID)
  if (!pending) return false
  pending.completedAt = now()
  loopCompactionRequests.set(sessionID, pending)
  await appendLoopLog(directory, "compact-event", { sessionID, job: pending.jobId, resumeAfter: pending.resumeAfter })
  const timer = setTimeout(() => {
    finalizeLoopCompaction(directory, client, sessionID)
      .catch((error) => log(client, "error", "compaction finalization failed", { error: sdkErrorMessage(error) }))
  }, 0)
  timer.unref?.()
  return true
}

async function recoverActiveDispatchFailure(directory, client, sessionID, jobId, runToken, error) {
  const active = activeRuns.get(sessionID)
  if (!active || active.jobId !== jobId || active.runToken !== runToken) return false

  clearActiveRun(sessionID)
  sessionStatuses.delete(sessionID)
  sessionStatusSeenAt.delete(sessionID)

  const message = sdkErrorMessage(error)
  const state = await readState(directory, sessionID)
  const job = (state.jobs || []).find((candidate) => candidate.id === jobId)
  if (job) {
    job.failureCount = (job.failureCount || 0) + 1
    job.lastFailureReason = "dispatch_failed"
    job.lastDispatchFailure = message.slice(0, 4000)
    job.lastDispatchFailureAt = now()
    if (job.maxFailures > 0 && job.failureCount >= job.maxFailures) {
      job.paused = true
      await notifyJob(directory, job, "dispatch_failed")
    }
    state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
    await writeState(directory, sessionID, state)
  }

  await appendLoopLog(directory, "dispatch-error", { sessionID, job: job?.name || jobId, error: message })
  await toast(client, `Loop dispatch failed${job?.paused ? " and paused" : ""}: ${message}`, job?.paused ? "error" : "warning")
  await scheduleDueWork(directory, client, sessionID, BUSY_RETRY_MS)
  return true
}

function goalReportPath(directory, sessionID, job) {
  return path.join(stateDir(directory), GOAL_REPORT_DIR, `${safeID(sessionID)}-${safeID(job.name || job.id)}.md`)
}

function goalReportText(job) {
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

async function writeGoalReport(directory, sessionID, job) {
  if (!isGoalJob(job)) return
  const target = job.goalEvidenceFile ? path.resolve(directory, job.goalEvidenceFile) : goalReportPath(directory, sessionID, job)
  await ensureDir(path.dirname(target))
  await fs.writeFile(target, goalReportText(job), "utf8")
}

function pickGoalJob(state, target = "") {
  const goals = (state.jobs || []).filter(isGoalJob)
  if (!goals.length) return undefined
  const text = String(target || "").trim()
  if (!text || ["active", "current", "goal"].includes(text.toLowerCase())) return goals.find((job) => job.goalStatus === "active" && job.enabled !== false) || goals[0]
  return goals.find((job, index) => matchJob(job, text, index))
}

function parseGoalToolText(args, fields) {
  const result = {}
  for (const field of fields) result[field] = String(args?.[field] || "").trim()
  return result
}

function hasConcreteGoalEvidence(value) {
  const text = String(value || "").trim()
  if (text.length < 24) return false
  const normalized = text.toLowerCase().replace(/\s+/g, " ")
  const weak = new Set(["done", "complete", "completed", "ok", "looks good", "n/a", "none", "no evidence", "no evidence provided", "goal completed", "marked complete"])
  if (weak.has(normalized) || normalized.startsWith("marked complete by /loop-goal-done")) return false
  return /(\b(npm|pnpm|yarn|bun|node|pytest|cargo|dotnet|go test|tsc|typecheck|test|tests|lint|build|check|checks|exit\s*\d|passed|verified|changed|updated|created|fixed|file|files|diff|commit)\b|[`\\/][\w./:-]+)/i.test(text) || text.length >= 80
}

function goalChecksPassed(job) {
  return Array.isArray(job?.lastGoalChecks) && job.lastGoalChecks.length > 0 && job.lastGoalChecks.every((item) => Number(item?.code) === 0)
}

function goalRequiresPassingChecks(job) {
  return job?.goalRequireChecksPass !== false && Array.isArray(job?.goalChecks) && job.goalChecks.length > 0
}

async function rejectGoalCompletion(directory, sessionID, state, job, reason) {
  job.goalCompletionRejectedAt = now()
  job.goalCompletionRejectedReason = reason
  job.goalCompletionRejectedCount = (job.goalCompletionRejectedCount || 0) + 1
  state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
  await writeState(directory, sessionID, state)
  await writeGoalReport(directory, sessionID, job)
  await appendLoopLog(directory, "goal-complete-rejected", { sessionID, job: job.name || job.id, reason })
  return { ok: false, job, rejected: true, message: `Goal completion rejected: ${reason}` }
}

function goalProgressSnapshot(job) {
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

function goalMadeMeaningfulProgress(beforeJob, afterJob) {
  const before = goalProgressSnapshot(beforeJob || {})
  const after = goalProgressSnapshot(afterJob || {})
  if (["completed", "blocked"].includes(after.status) && after.status !== before.status) return true
  if (after.progressCount > before.progressCount) return true
  if (after.evidence !== before.evidence && hasConcreteGoalEvidence(after.evidence)) return true
  if (after.checksPassedAt > before.checksPassedAt || goalChecksPassed(afterJob) && after.lastGoalCheckAt > before.lastGoalCheckAt) return true
  if (after.lastVerifyAt > before.lastVerifyAt && after.lastVerifyCode === 0) return true
  return false
}

async function applyGoalNoProgressGuard(directory, client, sessionID, job, beforeJob) {
  if (!isGoalJob(job) || ["completed", "blocked"].includes(job.goalStatus) || job.paused || job.enabled === false) return job
  const limit = Number(job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS)
  if (!Number.isFinite(limit) || limit <= 0) return job
  if (goalMadeMeaningfulProgress(beforeJob, job)) {
    job.noProgressCount = 0
    job.lastProgressAt = now()
    return job
  }
  job.noProgressCount = (job.noProgressCount || 0) + 1
  job.lastNoProgressAt = now()
  await appendLoopLog(directory, "goal-no-progress", { sessionID, job: job.name || job.id, count: job.noProgressCount, limit })
  if (job.noProgressCount >= limit) {
    job.paused = true
    job.goalNoProgressPausedAt = now()
    job.goalNoProgressReason = `Paused after ${job.noProgressCount} turn(s) without recorded progress. Resume with /loop-goal-resume after adjusting the goal or evidence.`
    await toast(client, job.goalNoProgressReason, "warning")
    await appendLoopLog(directory, "goal-no-progress-paused", { sessionID, job: job.name || job.id, count: job.noProgressCount, limit })
  }
  return job
}

async function setGoalComplete(directory, sessionID, args = {}) {
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

async function setGoalBlocked(directory, sessionID, args = {}) {
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

async function setGoalProgress(directory, sessionID, args = {}) {
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

async function runGoalChecks(directory, sessionID, job, client) {
  if (!isGoalJob(job) || !job.goalChecks?.length || ["completed", "blocked"].includes(job.goalStatus)) return job
  const results = []
  for (const command of job.goalChecks) {
    if (job.safe && dangerousShell(command)) {
      results.push({ command, code: -1, output: "Blocked dangerous command in safe mode." })
      continue
    }
    const result = await runShellCommand(command, directory, job.timeoutMs || 300_000)
    results.push({ command, code: result.code, output: (result.stdout + "\n" + result.stderr).slice(0, 1200) })
  }
  job.lastGoalCheckAt = now()
  job.lastGoalChecks = results
  const allPassed = results.length > 0 && results.every((item) => item.code === 0)
  if (allPassed) {
    job.goalChecksPassedAt = now()
    job.failureCount = 0
    await toast(client, "Goal checks passed.", "success")
    if (job.goalCompleteWhenChecksPass) {
      job.goalStatus = "completed"
      job.enabled = false
      job.paused = true
      job.goalCompletedAt = now()
      job.goalSummary = job.goalSummary || "All configured goal checks passed."
      job.goalEvidence = results.map((item) => `${item.command}: exit ${item.code}`).join("\n")
      await appendLoopLog(directory, "goal-auto-complete", { sessionID, job: job.name || job.id })
    }
  } else {
    job.failureCount = (job.failureCount || 0) + 1
    job.lastVerifyFailure = results.map((item) => `${item.command}\nexit=${item.code}\n${item.output}`).join("\n\n").slice(0, 4000)
    await toast(client, "Goal checks still failing; goal will continue on next idle turn.", "warning")
  }
  await appendLoopLog(directory, "goal-checks", { sessionID, job: job.name || job.id, results: results.map((item) => ({ command: item.command, code: item.code })) })
  return job
}

async function finalizeActiveRun(directory, client, sessionID, options = {}) {
  const active = activeRuns.get(sessionID)
  if (!active) return
  if (!await canFinalizeActiveRun(directory, client, sessionID, active, options)) return false
  const recoveredStale = staleActiveRun(sessionID)
  if (active.compactionOnly) {
    const pending = loopCompactionRequests.get(sessionID)
    clearActiveRun(sessionID)
    sessionStatuses.delete(sessionID)
    sessionStatusSeenAt.delete(sessionID)
    await appendLoopLog(directory, pending?.completedAt ? "compact-finished" : "compact-idle-fallback", {
      sessionID,
      job: active.job?.name || active.jobId,
      startedAt: active.startedAt,
      nativeEvent: Boolean(pending?.completedAt),
    })
    await scheduleDueWork(directory, client, sessionID)
    return true
  }
  clearActiveRun(sessionID)
  const state = await readState(directory, sessionID)
  let job = (state.jobs || []).find((candidate) => candidate.id === active.jobId)
  if (!job) return
  job.lastFinishedAt = now()
  if (recoveredStale) await appendLoopLog(directory, "active-stale-recovery", { sessionID, job: job.name || job.id, startedAt: active.startedAt })

  if (job.verifyCommand) {
    const verify = await runShellCommand(job.verifyCommand, directory, job.timeoutMs || 300_000)
    job.lastVerifyAt = now()
    job.lastVerifyCode = verify.code
    if (verify.code === 0) {
      job.failureCount = 0
      job.lastVerifyFailure = ""
      await toast(client, "Loop verify passed: " + job.verifyCommand, "success")
    } else {
      job.failureCount = (job.failureCount || 0) + 1
      job.lastVerifyFailure = (job.verifyCommand + "\nexit=" + verify.code + "\n" + verify.stdout + "\n" + verify.stderr).slice(0, 4000)
      await toast(client, "Loop verify failed: " + job.verifyCommand, "warning")
      if (job.pauseOnVerifyFail || (job.maxFailures > 0 && job.failureCount >= job.maxFailures)) {
        job.paused = true
        await notifyJob(directory, job, "verify_failed")
      }
    }
    await appendLoopLog(directory, "verify", { sessionID, job: job.name || job.id, command: job.verifyCommand, code: verify.code, failures: job.failureCount || 0 })
  }

  if (job.postrunCommand) {
    if (job.safe && dangerousShell(job.postrunCommand)) await appendLoopLog(directory, "postrun-blocked", { sessionID, job: job.name || job.id, command: job.postrunCommand })
    else {
      const postrun = await runShellCommand(job.postrunCommand, directory, job.timeoutMs || 300_000)
      job.lastPostrunCode = postrun.code
      job.lastPostrunAt = now()
      if (postrun.code !== 0) {
        job.failureCount = (job.failureCount || 0) + 1
        job.lastPostrunFailure = (job.postrunCommand + "\nexit=" + postrun.code + "\n" + postrun.stdout + "\n" + postrun.stderr).slice(0, 4000)
        if (job.maxFailures > 0 && job.failureCount >= job.maxFailures) {
          job.paused = true
          await notifyJob(directory, job, "postrun_failed")
        }
      }
      await appendLoopLog(directory, "postrun", { sessionID, job: job.name || job.id, command: job.postrunCommand, code: postrun.code })
    }
  }

  if (isGoalJob(job)) {
    job = await runGoalChecks(directory, sessionID, job, client)
    job = await applyGoalNoProgressGuard(directory, client, sessionID, job, active.job)
  }
  state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate).filter((candidate) => candidate.enabled !== false || isGoalJob(candidate))
  await writeState(directory, sessionID, state)
  if (isGoalJob(job)) await writeGoalReport(directory, sessionID, job)
  await createCheckpoint(directory, sessionID, job, client)
  await scheduleDueWork(directory, client, sessionID)
  return true
}

async function fireAction(directory, client, sessionID, job) {
  const action = String(job.action || "").trim()
  const kind = actionKind(action, job)
  const agent = job.agent || "build"
  const model = normalizedModelRef(job.model)
  if (kind === "compact") {
    beginLoopCompaction(sessionID, job.id, false)
    const ok = await compactSession(directory, client, sessionID, model)
    if (!ok) loopCompactionRequests.delete(sessionID)
    return { startsAssistantTurn: ok, pause: !ok, reason: "compact_failed", compaction: ok }
  }
  if (kind === "command") {
    const normalized = action.startsWith("/") ? action.slice(1) : action
    const [command, argumentsText] = splitFirst(normalized)
    if (!command) {
      await toast(client, "Loop command action is empty. Example: /loop-command 200m /compact", "warning")
      return { startsAssistantTurn: false, pause: true, reason: "empty_command" }
    }
    const tuiCommand = compactTuiCommandName(command)
    if (tuiCommand) {
      guardLoopOwnedUserMessage(sessionID)
      beginLoopCompaction(sessionID, job.id, false)
      const ok = await compactSession(directory, client, sessionID, model)
      if (!ok) loopCompactionRequests.delete(sessionID)
      return { startsAssistantTurn: ok, pause: !ok, reason: "compact_failed", compaction: ok }
    }
    guardLoopOwnedUserMessage(sessionID)
    const commandBody = { command, arguments: argumentsText, agent }
    if (model) commandBody.model = `${model.providerID}/${model.modelID}`
    await sdkCall(
      client.session.command.bind(client.session),
      { path: { id: sessionID }, body: commandBody },
      { path: { sessionID }, body: commandBody },
      { sessionID, ...commandBody },
    )
    return { startsAssistantTurn: true }
  }
  if (kind === "shell") {
    const command = action.replace(/^[!$]\s*/, "").trim()
    if (job.safe && dangerousShell(command)) {
      await toast(client, `Blocked dangerous shell command in safe mode: ${command}`, "error")
      await appendLoopLog(directory, "blocked", { sessionID, job: job.name || job.id, command })
      return { startsAssistantTurn: false, pause: true, reason: "safe_shell_blocked" }
    }
    guardLoopOwnedUserMessage(sessionID)
    const shellBody = { command, agent }
    if (model) shellBody.model = model
    const dispatch = fireSdk(
      client,
      "session.shell",
      client.session.shell.bind(client.session),
      { path: { id: sessionID }, body: shellBody },
      { path: { sessionID }, body: shellBody },
      { sessionID, ...shellBody },
    )
    return { startsAssistantTurn: true, dispatch }
  }
  const prompt = await buildPrompt(directory, job)
  const prefix = kind === "goal"
    ? "EXPERIMENTAL GOAL MODE CONTINUATION. Continue pursuing the active goal. Do not explain the /loop-goal command. Use the goal tools only when progress/completion/block state is real."
    : "AUTONOMOUS OPENCODE LOOP ITERATION. Continue the configured task now. Do not explain the /loop command. Do not search for documentation about this plugin. Do not create scheduler files. Do not ask questions. Make reasonable assumptions and work directly."
  const promptText = `${prefix}

${prompt}`
  guardLoopOwnedUserMessage(sessionID)
  const promptBody = { agent, parts: [{ type: "text", text: promptText }] }
  if (model) promptBody.model = model
  const dispatch = fireSdk(
    client,
    "session.prompt",
    client.session.prompt.bind(client.session),
    { path: { id: sessionID }, body: promptBody },
    { path: { sessionID }, body: promptBody },
    { sessionID, ...promptBody },
  )
  return { startsAssistantTurn: true, dispatch }
}

async function maybeRunDueJobs(directory, client, sessionID, options = {}) {
  rememberSession(directory, client, sessionID)
  const reschedule = async (minDelayMs = 0) => { await scheduleDueWork(directory, client, sessionID, minDelayMs) }

  if (runLocks.has(sessionID)) {
    await reschedule(BUSY_RETRY_MS)
    return
  }
  runLocks.set(sessionID, now())
  let job
  try {
    await finalizeActiveRun(directory, client, sessionID, { requireIdle: true, forceStale: true })
    if (!await sessionIsIdle(client, sessionID, directory)) {
      if (options.force) await toast(client, "Loop queued: session is busy; it will run on the next idle check.", "info")
      await reschedule(BUSY_RETRY_MS)
      return
    }

    const active = activeRuns.get(sessionID)
    const activeAge = active ? now() - (active.startedAt || 0) : 0
    const activeGuard = active?.job?.timeoutMs || active?.job?.activeRecoveryMs || DEFAULT_ACTIVE_GUARD_MS
    if (active && active.job?.noOverlap !== false && activeAge < activeGuard) {
      await reschedule(BUSY_RETRY_MS)
      return
    }
    if (active && activeAge >= activeGuard) clearActiveRun(sessionID)

    const state = await readState(directory, sessionID)
    for (const candidate of state.jobs || []) {
      if (candidate.watchPaths?.length && !candidate.paused && candidate.enabled && await watchChanged(directory, candidate)) candidate.watchTriggered = true
    }
    const due = dueJobs(state, options.force)
    if (!due.length) {
      await writeState(directory, sessionID, state)
      await reschedule()
      return
    }
    job = due[0]

    if (job.maxRuntimeMs > 0 && now() - Date.parse(job.createdAt || new Date().toISOString()) >= job.maxRuntimeMs) {
      state.jobs = (state.jobs || []).filter((candidate) => candidate.id !== job.id)
      await writeState(directory, sessionID, state)
      await notifyJob(directory, job, "max_runtime_reached")
      await toast(client, `Loop stopped by --max-runtime: ${job.name || job.id}`, "success")
      await appendLoopLog(directory, "max-runtime", { sessionID, job: job.name || job.id })
      await reschedule()
      return
    }
    if (job.stopFile && await pathExists(path.resolve(directory, job.stopFile))) {
      state.jobs = (state.jobs || []).filter((candidate) => candidate.id !== job.id)
      await writeState(directory, sessionID, state)
      await notifyJob(directory, job, "stop_file")
      await toast(client, "Loop stopped by --stop-file: " + job.stopFile, "success")
      await reschedule()
      return
    }
    if (await untilReached(directory, job)) {
      state.jobs = (state.jobs || []).filter((candidate) => candidate.id !== job.id)
      await writeState(directory, sessionID, state)
      await notifyJob(directory, job, "until_reached")
      await toast(client, `Loop stopped by --until: ${job.until}`, "success")
      await reschedule()
      return
    }

    if (job.preflightCommand) {
      if (job.safe && dangerousShell(job.preflightCommand)) {
        job.paused = true
        await writeState(directory, sessionID, state)
        await notifyJob(directory, job, "preflight_blocked")
        await toast(client, "Preflight blocked in safe mode and loop paused: " + job.preflightCommand, "error")
        await reschedule()
        return
      }
      const preflight = await runShellCommand(job.preflightCommand, directory, job.timeoutMs || 300_000)
      await appendLoopLog(directory, "preflight", { sessionID, job: job.name || job.id, command: job.preflightCommand, code: preflight.code })
      if (preflight.code !== 0) {
        job.paused = true
        job.failureCount = (job.failureCount || 0) + 1
        job.lastPreflightFailure = (job.preflightCommand + "\nexit=" + preflight.code + "\n" + preflight.stdout + "\n" + preflight.stderr).slice(0, 4000)
        state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
        await writeState(directory, sessionID, state)
        await notifyJob(directory, job, "preflight_failed")
        await toast(client, "Preflight failed and loop paused: " + job.preflightCommand, "warning")
        await reschedule()
        return
      }
    }

    job = await ensureBranch(directory, job, client, sessionID)
    const compactResult = await maybeCompact(directory, client, sessionID, job)
    job = compactResult.job
    if (compactResult.started) {
      state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
      await writeState(directory, sessionID, state)
      let timer
      if (job.timeoutMs > 0) timer = setTimeout(() => { fireSdk(client, "session.abort", client.session.abort.bind(client.session), { path: { id: sessionID }, body: {} }, { path: { sessionID }, body: {} }, { sessionID }); toast(client, `Loop compact timeout fired: ${job.name || job.id}`, "warning").catch(() => {}) }, job.timeoutMs)
      const runToken = `${job.id}:compact:${now().toString(36)}:${Math.random().toString(16).slice(2)}`
      activeRuns.set(sessionID, { jobId: job.id, job, startedAt: now(), timer, runToken, compactionOnly: true })
      const pending = loopCompactionRequests.get(sessionID)
      if (pending?.jobId === job.id && pending.completedAt) {
        await finalizeLoopCompaction(directory, client, sessionID)
        return
      }
      sessionStatuses.set(sessionID, "busy")
      sessionStatusSeenAt.set(sessionID, now())
      await reschedule(BUSY_RETRY_MS)
      return
    }
    job.watchTriggered = false
    job.lastRunAt = now()
    job.runCount = (job.runCount || 0) + 1
    if (job.maxRuns > 0 && job.runCount >= job.maxRuns) {
      job.enabled = false
      await notifyJob(directory, job, "max_runs_reached")
    }
    state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
    await writeState(directory, sessionID, state)
    await appendLoopLog(directory, "run", { sessionID, job: job.name || job.id, runCount: job.runCount })
    await toast(client, `Loop running: ${job.name || job.id}`, "info")

    try {
      const result = await fireAction(directory, client, sessionID, job)
      if (!result.startsAssistantTurn) {
        const fresh = await readState(directory, sessionID)
        if (result.pause) {
          fresh.jobs = (fresh.jobs || []).map((candidate) => candidate.id === job.id ? {
            ...candidate,
            paused: true,
            failureCount: (candidate.failureCount || 0) + 1,
            lastFailureReason: result.reason || "action_did_not_start",
          } : candidate)
        }
        fresh.jobs = (fresh.jobs || []).filter((candidate) => candidate.enabled !== false || isGoalJob(candidate))
        await writeState(directory, sessionID, fresh)
        await reschedule()
        return
      }
      let timer
      if (job.timeoutMs > 0) timer = setTimeout(() => { fireSdk(client, "session.abort", client.session.abort.bind(client.session), { path: { id: sessionID }, body: {} }, { path: { sessionID }, body: {} }, { sessionID }); toast(client, `Loop timeout fired: ${job.name || job.id}`, "warning").catch(() => {}) }, job.timeoutMs)
      const runToken = `${job.id}:${now().toString(36)}:${Math.random().toString(16).slice(2)}`
      activeRuns.set(sessionID, { jobId: job.id, job, startedAt: now(), timer, runToken, compactionAction: result.compaction === true })
      if (result.compaction) {
        const pending = loopCompactionRequests.get(sessionID)
        if (pending?.jobId === job.id && pending.completedAt) {
          await finalizeLoopCompaction(directory, client, sessionID)
          return
        }
      }
      if (result.dispatch) {
        void result.dispatch.catch((error) => {
          recoverActiveDispatchFailure(directory, client, sessionID, job.id, runToken, error)
            .catch((recoveryError) => log(client, "error", "dispatch recovery failed", { error: sdkErrorMessage(recoveryError) }))
        })
      }
      sessionStatuses.set(sessionID, "busy")
      sessionStatusSeenAt.set(sessionID, now())
      await reschedule(BUSY_RETRY_MS)
    } catch (error) {
      clearActiveRun(sessionID)
      await toast(client, `Loop job failed: ${error instanceof Error ? error.message : String(error)}`, "error")
      await appendLoopLog(directory, "error", { sessionID, job: job?.name || job?.id, error: error instanceof Error ? error.message : String(error) })
      await reschedule(BUSY_RETRY_MS)
    }
  } finally {
    runLocks.delete(sessionID)
  }
}

function normalizeActionForCompare(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function sameLoopDefinition(a, b) {
  if (!a || !b) return false
  return (a.name || "") === (b.name || "") &&
    Number(a.intervalMs || 0) === Number(b.intervalMs || 0) &&
    normalizeActionForCompare(a.action) === normalizeActionForCompare(b.action) &&
    normalizeActionForCompare(a.kind) === normalizeActionForCompare(b.kind) &&
    normalizeActionForCompare(a.promptFile) === normalizeActionForCompare(b.promptFile)
}

async function addLoop(directory, client, sessionID, args, defaults = {}) {
  const parsed = parseLoopArgs(args, defaults)
  if (!parsed.ok) { await toast(client, parsed.error, "warning"); return }
  const executionContext = sessionExecutionContexts.get(sessionID) || { agent: "build" }
  parsed.job.agent = defaults.agent || executionContext.agent || "build"
  parsed.job.model = normalizedModelRef(defaults.model) || executionContext.model
  if (defaults.testfixPreset) {
    const defaultCommand = String(defaults.verifyCommand || "npm test")
    const parsedAction = String(parsed.job.action || "").trim()
    const usedDefaultAction = parsedAction === String(defaults.action || "").trim()
    if (!usedDefaultAction && parsed.job.verifyCommand === defaults.verifyCommand) {
      parsed.job.verifyCommand = parsedAction
      parsed.job.action = `Run the project tests. Fix failures. Re-run the tests. Test command hint: ${parsedAction}`
    } else if (usedDefaultAction && parsed.job.verifyCommand !== defaults.verifyCommand) {
      parsed.job.action = `Run the project tests. Fix failures. Re-run the tests. Test command hint: ${parsed.job.verifyCommand || defaultCommand}`
    }
  }
  if (parsed.job.watchPaths.length) parsed.job.watchSnapshot = await snapshotPaths(directory, parsed.job.watchPaths)
  if (!parsed.job.activeRecoveryMs) {
    parsed.job.activeRecoveryMs = isGoalJob(parsed.job)
      ? DEFAULT_GOAL_ACTIVE_RECOVERY_MS
      : Math.max(DEFAULT_ACTIVE_GUARD_MS, Math.min(90_000, (parsed.job.intervalMs || 0) + 10_000))
  }
  if (parsed.job.dryRun) { await toast(client, `Loop dry run: ${jobLabel(parsed.job)}`, "info"); await say(client, sessionID, "OpenCode loop dry run:\n```json\n" + JSON.stringify(parsed.job, null, 2) + "\n```"); return }
  const state = await readState(directory, sessionID)
  const jobs = Array.isArray(state.jobs) ? state.jobs : []

  // Default behavior is replace/upsert, not append forever. This prevents duplicate
  // loops when OpenCode emits both command.execute.before and command.executed,
  // and it matches the common expectation that /loop configures the current loop.
  let replaced = false
  if (!parsed.job.multi) {
    const targetName = parsed.job.name || "default"
    parsed.job.name = targetName
    state.jobs = jobs.filter((existing) => {
      const existingName = existing.name || "default"
      const shouldReplace = existingName === targetName || sameLoopDefinition(existing, parsed.job)
      if (shouldReplace) replaced = true
      return !shouldReplace
    })
  } else {
    state.jobs = jobs
  }

  state.jobs.push(parsed.job)
  await writeState(directory, sessionID, state)
  await scheduleDueWork(directory, client, sessionID)
  if (parsed.job.immediate) scheduleIdleWork(directory, client, sessionID)
  await toast(client, `${replaced ? "Loop replaced" : "Loop added"}: ${jobLabel(parsed.job)}`, "success")
  await appendLoopLog(directory, replaced ? "replace" : "add", { sessionID, job: parsed.job.name || parsed.job.id, label: jobLabel(parsed.job) })
}

async function stopLoop(directory, client, sessionID, args) {
  const target = String(args || "").trim()
  if (!target || target.toLowerCase() === "all") {
    await removeState(directory, sessionID)
    clearActiveRun(sessionID)
    const due = dueTimers.get(sessionID); if (due) clearTimeout(due); dueTimers.delete(sessionID)
    stopWatchdog(sessionID)
    await toast(client, "All loops stopped for this session.", "success")
    return
  }
  const state = await readState(directory, sessionID)
  const before = state.jobs.length
  state.jobs = state.jobs.filter((job, index) => !matchJob(job, target, index))
  await writeState(directory, sessionID, state)
  await scheduleDueWork(directory, client, sessionID)
  await toast(client, `Stopped ${before - state.jobs.length} loop(s).`, "success")
}

async function updateJobState(directory, client, sessionID, args, updater, message) {
  const target = String(args || "").trim() || "all"
  const state = await readState(directory, sessionID)
  let count = 0
  state.jobs = (state.jobs || []).map((job, index) => matchJob(job, target, index) ? (count++, updater(job)) : job)
  await writeState(directory, sessionID, state)
  await scheduleDueWork(directory, client, sessionID)
  await toast(client, `${message}: ${count} loop(s).`, count ? "success" : "warning")
}

async function statusGoal(directory, client, sessionID) {
  const state = await readState(directory, sessionID)
  const goals = (state.jobs || []).filter(isGoalJob)
  const lines = goals.length ? goals.map((job, index) => {
    const status = goalStatusText(job)
    const checks = job.goalChecks?.length ? ` | checks=${job.goalChecks.length}` : ""
    const acceptance = job.goalAcceptance?.length ? ` | acceptance=${job.goalAcceptance.length}` : ""
    const progress = job.goalProgress?.length ? ` | progress=${job.goalProgress.length}` : ""
    const noProgress = (job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS) > 0 ? ` | no-progress=${job.noProgressCount || 0}/${job.maxNoProgress ?? DEFAULT_GOAL_MAX_NO_PROGRESS}` : ""
    const rejected = job.goalCompletionRejectedReason ? " | completion-rejected" : ""
    return `${index + 1}. ${job.id}${job.name ? ` (${job.name})` : ""}: ${status} | turns=${job.runCount || 0} | objective=${String(job.action || job.goalFile || "").slice(0, 220)}${checks}${acceptance}${progress}${noProgress}${rejected}`
  }) : ["No experimental goal jobs."]
  await toast(client, goals.length ? `${goals.length} experimental goal(s).` : "No experimental goal jobs.", goals.length ? "info" : "warning")
  await say(client, sessionID, "OpenCode Loop experimental goal status:\n" + lines.join("\n"))
}

async function pauseGoal(directory, client, sessionID, args) {
  const target = String(args || "").trim() || "goal"
  const state = await readState(directory, sessionID)
  let count = 0
  state.jobs = (state.jobs || []).map((job, index) => isGoalJob(job) && matchJob(job, target, index) ? (count++, { ...job, paused: true }) : job)
  await writeState(directory, sessionID, state)
  await scheduleDueWork(directory, client, sessionID)
  await toast(client, `Paused ${count} experimental goal(s).`, count ? "success" : "warning")
}

async function resumeGoal(directory, client, sessionID, args) {
  const target = String(args || "").trim() || "goal"
  const state = await readState(directory, sessionID)
  let count = 0
  state.jobs = (state.jobs || []).map((job, index) => {
    if (!isGoalJob(job) || !matchJob(job, target, index)) return job
    count++
    return { ...job, paused: false, enabled: true, goalStatus: job.goalStatus === "blocked" ? "active" : (job.goalStatus || "active"), lastRunAt: 0, noProgressCount: 0, goalNoProgressReason: "", goalInterruptedReason: "" }
  })
  await writeState(directory, sessionID, state)
  await toast(client, `Resumed ${count} experimental goal(s).`, count ? "success" : "warning")
  if (count) {
    await scheduleDueWork(directory, client, sessionID)
    scheduleIdleWork(directory, client, sessionID)
  }
}

async function clearGoal(directory, client, sessionID, args) {
  const target = String(args || "").trim()
  const state = await readState(directory, sessionID)
  const before = state.jobs.length
  state.jobs = (state.jobs || []).filter((job, index) => !isGoalJob(job) || (target && !matchJob(job, target, index)))
  await writeState(directory, sessionID, state)
  await scheduleDueWork(directory, client, sessionID)
  await toast(client, `Cleared ${before - state.jobs.length} experimental goal(s).`, before !== state.jobs.length ? "success" : "warning")
}

async function completeGoalCommand(directory, client, sessionID, args) {
  const result = await setGoalComplete(directory, sessionID, { summary: String(args || "").trim() || "Goal manually marked complete.", evidence: "Marked complete by /loop-goal-done.", manual: true })
  await toast(client, result.message, result.ok ? "success" : "warning")
}

async function blockGoalCommand(directory, client, sessionID, args) {
  const result = await setGoalBlocked(directory, sessionID, { reason: String(args || "").trim() || "Goal manually marked blocked.", needed: "User input or manual intervention." })
  await toast(client, result.message, result.ok ? "warning" : "warning")
}

async function addGoal(directory, client, sessionID, args) {
  const text = String(args || "").trim()
  const [maybeCommand, rest] = splitFirst(text)
  const sub = maybeCommand.toLowerCase()
  if (!text || sub === "status") return await statusGoal(directory, client, sessionID)
  if (sub === "pause") return await pauseGoal(directory, client, sessionID, rest)
  if (sub === "resume") return await resumeGoal(directory, client, sessionID, rest)
  if (["clear", "remove", "stop"].includes(sub)) return await clearGoal(directory, client, sessionID, rest)
  if (["done", "complete", "completed"].includes(sub)) return await completeGoalCommand(directory, client, sessionID, rest)
  if (["blocked", "block"].includes(sub)) return await blockGoalCommand(directory, client, sessionID, rest)
  return await addLoop(directory, client, sessionID, text, { intervalMs: 0, kind: "goal", name: "goal", immediate: true, safe: true, askNever: true, noOverlap: true, goalStatus: "active" })
}

async function statusLoop(directory, client, sessionID) {
  const state = await readState(directory, sessionID)
  const jobs = state.jobs || []
  const lines = jobs.length ? jobs.map((job, index) => {
    const dueIn = Math.max(0, job.intervalMs - (now() - (job.lastRunAt || 0)))
    const flags = [isGoalJob(job) ? `goal:${goalStatusText(job)}` : undefined, job.paused ? "paused" : "active", job.safe ? "safe" : undefined, job.askNever ? "ask-never" : undefined, job.noOverlap ? "no-overlap" : undefined, job.checkpointOnly ? "checkpoint-only" : undefined, job.gitCheckpoint ? "git-checkpoint" : undefined].filter(Boolean).join(",")
    return `${index + 1}. ${job.id}${job.name ? ` (${job.name})` : ""}: ${jobLabel(job)} | runs=${job.runCount || 0} | failures=${job.failureCount || 0} | due in ${durationToText(dueIn)} | ${flags}`
  }) : ["No active loop jobs."]
  await toast(client, jobs.length ? `${jobs.length} loop job(s).` : "No active loop jobs.", jobs.length ? "info" : "warning")
  await say(client, sessionID, "OpenCode loop status:\n" + lines.join("\n"))
}

async function logsLoop(directory, client, sessionID) {
  let text = "No loop log found."
  try { text = (await fs.readFile(path.join(stateDir(directory), "loop.log"), "utf8")).trim().split(/\r?\n/).slice(-80).join("\n") || text } catch {}
  await say(client, sessionID, "OpenCode loop logs:\n" + text)
}

async function helpLoop(client, sessionID) {
  await say(client, sessionID, [
    "OpenCode Loop help:",
    "/loop 0s <prompt>                                Claude Code style auto-continue",
    "/loop 5m --ask-never --safe <prompt>              interval autonomous prompt loop",
    "/loop-command 200m /compact                       OpenCode slash-command loop, waits for idle",
    "/loop-ask 1h did you run tests and tsc --noEmit?   scheduled question/check prompt",
    "/loop-shell 10m npm test                           shell loop, waits for idle",
    "/loop-goal finish the feature and keep tests green  experimental persistent goal mode",
    "/loop-goal --check \"npm run build\" --check \"npm test\" --complete-when-checks-pass ship it",
    "/loop-goal status | pause | resume | clear          manage experimental goals",
    "/loop 200m --command /compact                     same as command loop",
    "/loop 0s --verify \"npm test\" <prompt>            verify after each assistant turn",
    "/loop 0s --prompt-file loop-prompt.md             load prompt from a file",
    "/loop 0s --max-runtime 6h --max-failures 3 <task> stop safely after limits",
    "/loop-doctor | /loop-init | /loop-export",
  ].join("\n"))
}

async function runNow(directory, client, sessionID, args) {
  const target = String(args || "").trim() || "all"
  const state = await readState(directory, sessionID)
  let count = 0
  for (const [index, job] of (state.jobs || []).entries()) if (matchJob(job, target, index)) { job.lastRunAt = 0; job.paused = false; count++ }
  await writeState(directory, sessionID, state)
  await toast(client, `Marked ${count} loop job(s) due now.`, count ? "success" : "warning")
  await maybeRunDueJobs(directory, client, sessionID, { force: true })
}

async function doctorLoop(directory, client, sessionID) {
  const state = await readState(directory, sessionID)
  await say(client, sessionID, [
    "OpenCode Loop doctor:",
    `- plugin: ${SERVICE}`,
    `- project directory: ${directory}`,
    `- state directory: ${stateDir(directory)}`,
    `- active jobs: ${(state.jobs || []).length}`,
    `- node: ${process.version}`,
    `- platform: ${process.platform}`,
    "- smoke test: /loop 0s --max-runs 1 --dry-run continue from progress.md",
    "- experimental goal smoke test: /loop-goal --dry-run finish the current task and verify it",
  ].join("\n"))
}

async function initLoop(directory, client, sessionID, args) {
  const target = String(args || "").trim() || "progress.md"
  const full = path.resolve(directory, target)
  if (await pathExists(full)) { await toast(client, `${target} already exists.`, "warning"); return }
  await fs.writeFile(full, DEFAULT_PROGRESS_MD, "utf8")
  await toast(client, `Created ${target}.`, "success")
  await appendLoopLog(directory, "init", { sessionID, file: target })
}

async function exportLoop(directory, client, sessionID) {
  const state = await readState(directory, sessionID)
  await say(client, sessionID, "OpenCode loop state export:\n```json\n" + JSON.stringify(state, null, 2) + "\n```")
}

async function handleCommand(directory, client, input, fallbackName, fallbackArgs, output, source = "before") {
  const name = commandName(input?.command ?? input?.name ?? fallbackName)
  const sessionID = input?.sessionID
  const args = commandArgsText(input?.arguments ?? fallbackArgs ?? "")
  if (!sessionID || !name) return false
  rememberSession(directory, client, sessionID)
  if (isLoopCommandName(name)) await captureSessionExecutionContext(client, sessionID)
  if (source === "event") {
    if (consumeHandled(sessionID, name, args)) return true
    const eventKey = commandEventKey(sessionID, input?.messageID)
    if (handledCommandEvents.has(eventKey)) return true
    handledCommandEvents.set(eventKey, now())
  } else {
    // Every before-hook invocation is an intentional command. Keep a pending
    // count only so the matching command.executed compatibility event can be
    // consumed without suppressing a genuine repeated command.
    markHandled(sessionID, name, args)
  }
  if (isLoopCommandName(name)) guardLoopOwnedUserMessage(sessionID)

  const handled = () => {
    // OpenCode 1.18.x ignores unknown hook output fields, while proposed/newer
    // hosts can honor noReply to skip the otherwise unavoidable model turn.
    // Keep acknowledgement parts intact as the compatibility fallback.
    if (output && typeof output === "object") output.noReply = true
    return true
  }

  if (name === "loop-goal") return await addGoal(directory, client, sessionID, args), handled()
  if (name === "loop-goal-status") return await statusGoal(directory, client, sessionID), handled()
  if (name === "loop-goal-pause") return await pauseGoal(directory, client, sessionID, args), handled()
  if (name === "loop-goal-resume") return await resumeGoal(directory, client, sessionID, args), handled()
  if (name === "loop-goal-clear") return await clearGoal(directory, client, sessionID, args), handled()
  if (name === "loop-goal-done" || name === "loop-goal-complete") return await completeGoalCommand(directory, client, sessionID, args), handled()
  if (name === "loop-goal-blocked") return await blockGoalCommand(directory, client, sessionID, args), handled()
  if (name === "loop") return await addLoop(directory, client, sessionID, args), handled()
  if (isPreset(name)) return await addLoop(directory, client, sessionID, args, presetDefaults(name, args)), handled()
  if (name === "loop-stop" || name === "loop-remove") return await stopLoop(directory, client, sessionID, args), handled()
  if (name === "loop-clear") return await stopLoop(directory, client, sessionID, "all"), handled()
  if (name === "loop-status") return await statusLoop(directory, client, sessionID), handled()
  if (name === "loop-logs") return await logsLoop(directory, client, sessionID), handled()
  if (name === "loop-help") return await helpLoop(client, sessionID), handled()
  if (name === "loop-now") return await runNow(directory, client, sessionID, args), handled()
  if (name === "loop-pause") return await updateJobState(directory, client, sessionID, args, (job) => ({ ...job, paused: true }), "Paused"), handled()
  if (name === "loop-resume") return await updateJobState(directory, client, sessionID, args, (job) => ({ ...job, paused: false, lastRunAt: 0 }), "Resumed"), handled()
  if (name === "loop-doctor") return await doctorLoop(directory, client, sessionID), handled()
  if (name === "loop-init") return await initLoop(directory, client, sessionID, args), handled()
  if (name === "loop-export") return await exportLoop(directory, client, sessionID), handled()
  if (source === "event") handledCommandEvents.delete(commandEventKey(sessionID, input?.messageID))
  else consumeHandled(sessionID, name, args)
  return false
}

function goalTools(defaultDirectory) {
  return {
    opencode_loop_goal_complete: tool({
      description: "Mark the current OpenCode Loop experimental goal as completed. Use only after acceptance criteria are satisfied and you have evidence from tests, typecheck, build, or code inspection.",
      args: {
        summary: tool.schema.string().describe("Short human-readable summary of what was completed."),
        evidence: tool.schema.string().describe("Concrete evidence that the goal is complete, such as commands run, passing checks, files changed, and important results."),
      },
      execute: async (args, context) => {
        const result = await setGoalComplete(context.directory || defaultDirectory, context.sessionID, args)
        return { title: result.ok ? "Goal completed" : result.rejected ? "Goal completion rejected" : "Goal not found", output: result.message }
      },
    }),
    opencode_loop_goal_blocked: tool({
      description: "Mark the current OpenCode Loop experimental goal as blocked when user input or manual intervention is required.",
      args: {
        reason: tool.schema.string().describe("Why the goal is blocked."),
        needed: tool.schema.string().describe("What user input, credential, decision, or manual action is needed to continue."),
      },
      execute: async (args, context) => {
        const result = await setGoalBlocked(context.directory || defaultDirectory, context.sessionID, args)
        return { title: result.ok ? "Goal blocked" : "Goal not found", output: result.message }
      },
    }),
    opencode_loop_goal_progress: tool({
      description: "Record meaningful progress on the current OpenCode Loop experimental goal without completing it.",
      args: {
        summary: tool.schema.string().describe("What useful progress was made."),
        next: tool.schema.string().describe("The next step toward completing the goal."),
      },
      execute: async (args, context) => {
        const result = await setGoalProgress(context.directory || defaultDirectory, context.sessionID, args)
        return { title: result.ok ? "Goal progress" : "Goal not found", output: result.message }
      },
    }),
  }
}

export const OpenCodeLoopPlugin = async ({ client, directory }) => {
  // OpenCode's local SDK can be slow or unavailable while a project instance
  // is still waiting for its plugins to return their hooks. Defer bootstrap
  // calls so headless/server sessions cannot deadlock during plugin loading.
  const bootstrap = setTimeout(() => {
    log(client, "info", "Plugin initialized", { directory }).catch(() => {})
    refreshSessionRelationships(client, directory).catch(() => {})
  }, 0)
  bootstrap.unref?.()
  return {
    dispose: async () => { disposeRuntime(directory, client) },
    tool: goalTools(directory),
    "command.execute.before": async (input, output) => { await handleCommand(directory, client, input, undefined, undefined, output) },
    "tool.execute.before": async (input) => { markToolCallActive(input) },
    "tool.execute.after": async (input) => { markToolCallFinished(input) },
    "experimental.session.compacting": async (input) => { await noteLoopCompactionStarted(directory, input?.sessionID) },
    event: async ({ event }) => {
      if (event.type === "session.compacted") await noteLoopCompactionCompleted(directory, client, event?.properties?.sessionID)
      updateSessionRelationshipFromEvent(event)
      if (event.type === "message.updated") updateSessionExecutionContext(event?.properties?.info)
      updateToolActivityFromEvent(event)
      if (event.type === "command.executed") {
        const props = event.properties || {}
        await handleCommand(directory, client, props, props.name, props.arguments, undefined, "event")
      }
      const interruptedSessionID = userInterruptSessionFromEvent(event)
      if (interruptedSessionID) {
        rememberSession(directory, client, interruptedSessionID)
        await pauseGoalsForUserInterrupt(directory, client, interruptedSessionID)
      }
      const statusUpdate = updateSessionStatusFromEvent(event)
      if (statusUpdate?.sessionID) rememberSession(directory, client, statusUpdate.sessionID)
      if (statusUpdate?.idle) scheduleIdleWork(directory, client, statusUpdate.sessionID)
    },
  }
}

export default OpenCodeLoopPlugin
