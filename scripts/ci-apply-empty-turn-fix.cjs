const fs = require('node:fs')

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, value) {
  fs.writeFileSync(file, value)
}

function replaceOnce(file, before, after) {
  const current = read(file)
  const first = current.indexOf(before)
  if (first < 0) throw new Error(`missing patch marker in ${file}: ${before.slice(0, 120)}`)
  if (current.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous patch marker in ${file}`)
  write(file, current.slice(0, first) + after + current.slice(first + before.length))
}

function replaceBlock(file, startMarker, endMarker, replacement) {
  const current = read(file)
  const start = current.indexOf(startMarker)
  if (start < 0) throw new Error(`missing start marker in ${file}`)
  const end = current.indexOf(endMarker, start)
  if (end < 0) throw new Error(`missing end marker in ${file}`)
  write(file, current.slice(0, start) + replacement + current.slice(end))
}

write('src/source/runtime/empty-turn.js', `import { actionKind } from "../core/jobs.js"

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
`)

replaceBlock(
  'src/source/opencode/host.js',
  'export async function activeRunCompletionFromMessages',
  'export async function resolveCompactionModel',
  `export function assistantMessageHasMeaningfulActivity(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  for (const part of parts) {
    if (!part || typeof part !== "object") continue
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) return true
    if (["tool", "file", "patch", "artifact"].includes(String(part.type || ""))) return true
  }
  const info = message?.info || message || {}
  return [info.text, info.content, info.summary].some((value) => typeof value === "string" && value.trim())
}

export async function activeRunCompletionFromMessages(directory, client, sessionID, active) {
  const messages = await readRecentSessionMessages(client, sessionID, directory)
  if (!messages) return "unknown"
  const ordered = orderedSessionMessages(messages)
  const tail = ordered.at(-1)
  const info = tail?.info || tail
  if (!info || info.role !== "assistant") return "incomplete"
  const completed = Number(info?.time?.completed || 0)
  const created = Number(info?.time?.created || 0)
  if (!Number.isFinite(completed) || completed <= 0) return "incomplete"
  const startedAt = Number(active?.startedAt || 0)
  if (startedAt > 0 && completed < startedAt && (!Number.isFinite(created) || created < startedAt)) return "incomplete"

  const relevant = ordered.filter((message) => {
    const candidate = message?.info || message || {}
    if (candidate.role !== "assistant") return false
    if (startedAt <= 0) return true
    const candidateCreated = Number(candidate?.time?.created || 0)
    const candidateCompleted = Number(candidate?.time?.completed || 0)
    return candidateCreated >= startedAt || candidateCompleted >= startedAt
  })
  return relevant.some(assistantMessageHasMeaningfulActivity) ? "completed" : "empty"
}

`
)

const statusFile = 'src/source/runtime/session-status.js'
replaceOnce(
  statusFile,
  `function nonNegativeNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}
`,
  `function nonNegativeNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function settledAssistantCompletion(value) {
  return value === "completed" || value === "empty"
}
`
)
replaceOnce(statusFile, '    if (completion === "completed") return true\n', '    if (settledAssistantCompletion(completion)) return true\n')
replaceOnce(statusFile, '    if (completion !== "completed") return false\n', '    if (!settledAssistantCompletion(completion)) return false\n')
replaceOnce(
  statusFile,
  '          if (completion === "completed" || (live.type === "busy" && completion === "unknown" && staleActiveRun(sessionID))) {\n',
  '          if (settledAssistantCompletion(completion) || (live.type === "busy" && completion === "unknown" && staleActiveRun(sessionID))) {\n'
)
replaceOnce(
  statusFile,
  `            await appendLoopLog(
              directory,
              completion === "completed" ? "status-message-complete-recovery" : "status-stale-recovery",
              logDetails,
            )
`,
  `            const recoveryEvent = completion === "empty"
              ? "status-message-empty-recovery"
              : completion === "completed"
                ? "status-message-complete-recovery"
                : "status-stale-recovery"
            await appendLoopLog(directory, recoveryEvent, logDetails)
`
)
replaceOnce(
  statusFile,
  '    readLiveSessionStatus,\n    sessionStatusType,\n',
  '    readLiveSessionStatus,\n    activeRunCompletion: activeRunCompletionFromMessages,\n    sessionStatusType,\n'
)

const executorFile = 'src/source/runtime/executor.js'
replaceOnce(
  executorFile,
  'import { isTransientNetworkError, networkRetryDelayMs, refundInfrastructureRun } from "./network-recovery.js"\n',
  'import { isTransientNetworkError, networkRetryDelayMs, refundInfrastructureRun } from "./network-recovery.js"\nimport { guardsEmptyAssistantTurn, refundEmptyAssistantTurn, clearEmptyAssistantTurnStreak } from "./empty-turn.js"\n'
)
replaceOnce(
  executorFile,
  '    canFinalizeActiveRun,\n    sessionStatusType,\n',
  '    canFinalizeActiveRun,\n    activeRunCompletion,\n    sessionStatusType,\n'
)
replaceBlock(
  executorFile,
  '  async function finalizeActiveRun',
  '\n\n  const fireAction = actionDispatcher.fireAction',
  `  async function finalizeActiveRun(directory, client, sessionID, finalizeOptions = {}) {
    const active = activeRuns.get(sessionID)
    if (!active) return
    if (!await canFinalizeActiveRun(directory, client, sessionID, active, finalizeOptions)) return false
    const completion = await activeRunCompletion(directory, client, sessionID, active)
    const recoveredStale = staleActiveRun(sessionID)
    if (active.compactionOnly) {
      const pending = compactionRuntime.getPending(sessionID)
      clearActiveRun(sessionID)
      clearSessionStatus(sessionID)
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

    if (completion === "empty" && guardsEmptyAssistantTurn(job)) {
      const empty = refundEmptyAssistantTurn(job, active, now())
      state.jobs = (state.jobs || []).map((candidate) => candidate.id === job.id ? job : candidate)
      await writeState(directory, sessionID, state)
      await appendLoopLog(directory, "empty-assistant-turn", {
        sessionID,
        job: job.name || job.id,
        count: empty.count,
        limit: empty.limit,
        paused: empty.paused,
        refunded: true,
      })
      if (empty.paused) {
        await notifyJob(directory, job, "empty_turn")
        await toast(client, "Loop paused after " + empty.count + " consecutive completed assistant turns with no visible output or tool activity. Resume after changing the model/prompt or use /loop-resume.", "warning")
        await scheduleDueWork(directory, client, sessionID)
      } else {
        await toast(client, "Loop received an empty completed assistant turn; the logical run was refunded and will retry once.", "warning")
        await scheduleDueWork(directory, client, sessionID, busyRetryMs)
      }
      return true
    }

    if (completion === "completed") clearEmptyAssistantTurnStreak(job)
    if (recoveredStale) {
      await appendLoopLog(directory, "active-stale-recovery", {
        sessionID,
        job: job.name || job.id,
        startedAt: active.startedAt,
      })
    }

    await finalizationRuntime.finalizeJob(directory, client, sessionID, state, job, active.job)
    return true
  }`
)

write('scripts/empty-turn-recovery-test.mjs', `import assert from "node:assert/strict"
import { activeRunCompletionFromMessages, assistantMessageHasMeaningfulActivity } from "../src/source/opencode/host.js"
import { createSessionStatusRuntime } from "../src/source/runtime/session-status.js"
import { createLoopExecutor } from "../src/source/runtime/executor.js"
import { refundEmptyAssistantTurn, clearEmptyAssistantTurnStreak } from "../src/source/runtime/empty-turn.js"
import { clearSessionActivity } from "../src/source/runtime/session-activity.js"

const blank = { info: { role: "assistant", time: { created: 120, completed: 130 } }, parts: [] }
const whitespace = { info: { role: "assistant", time: { created: 120, completed: 130 } }, parts: [{ type: "text", text: "   \\n" }] }
const text = { info: { role: "assistant", time: { created: 120, completed: 130 } }, parts: [{ type: "text", text: "done" }] }
const tool = { info: { role: "assistant", time: { created: 120, completed: 130 } }, parts: [{ type: "tool", callID: "call-1", state: { status: "completed" } }] }
assert.equal(assistantMessageHasMeaningfulActivity(blank), false)
assert.equal(assistantMessageHasMeaningfulActivity(whitespace), false)
assert.equal(assistantMessageHasMeaningfulActivity(text), true)
assert.equal(assistantMessageHasMeaningfulActivity(tool), true)

let hostMessages = [blank]
const hostClient = { session: { messages: async () => ({ data: hostMessages }) } }
assert.equal(await activeRunCompletionFromMessages("/repo", hostClient, "host-empty", { startedAt: 100 }), "empty")
hostMessages = [tool, { info: { role: "assistant", time: { created: 140, completed: 150 } }, parts: [] }]
assert.equal(await activeRunCompletionFromMessages("/repo", hostClient, "host-tool-then-blank", { startedAt: 100 }), "completed", "tool activity earlier in the same logical run must prevent a false empty classification")
hostMessages = [text]
assert.equal(await activeRunCompletionFromMessages("/repo", hostClient, "host-text", { startedAt: 100 }), "completed")

const pureJob = { id: "pure", enabled: false, paused: false, runCount: 1, maxRuns: 1, lastRunAt: 50 }
let pure = refundEmptyAssistantTurn(pureJob, { job: { runCount: 1 }, previousLastRunAt: 10, disabledByMaxRuns: true }, 200)
assert.equal(pure.job.runCount, 0)
assert.equal(pure.job.enabled, true)
assert.equal(pure.job.lastRunAt, 10)
assert.equal(pure.job.runNowRequestedAt, 200)
assert.equal(pure.job.emptyTurnCount, 1)
assert.equal(pure.paused, false)
pure = refundEmptyAssistantTurn(pure.job, { job: { runCount: 1 }, previousLastRunAt: 10, disabledByMaxRuns: true }, 300)
assert.equal(pure.paused, true)
assert.equal(pure.job.paused, true)
assert.equal(pure.job.runNowRequestedAt, undefined)
clearEmptyAssistantTurnStreak(pure.job)
assert.equal(pure.job.emptyTurnCount, 0)
assert.equal(pure.job.lastFailureReason, undefined)

const statusLogs = []
const statusActive = new Map([["status-empty", { jobId: "j", job: { id: "j" }, startedAt: 100 }]])
const statusRuntime = createSessionStatusRuntime({
  activeRuns: statusActive,
  now: () => 10_000,
  sessionStatusCacheMs: 0,
  activeRunCompletionFromMessages: async () => "empty",
  appendLoopLog: async (...args) => statusLogs.push(args),
})
const statusClient = { session: { status: async () => ({ data: { "status-empty": { type: "busy" } } }) } }
assert.equal(await statusRuntime.sessionStatusType(statusClient, "status-empty", "/repo"), "idle", "a host-busy tail that is already an empty completed assistant turn must settle so the empty-turn guard can run")
assert.ok(statusLogs.some((entry) => entry[1] === "status-message-empty-recovery"))
clearSessionActivity("status-empty")

let clock = 1_000
let outcome = "empty"
const states = new Map()
const schedules = []
const toasts = []
const notifications = []
const checkpoints = []
const key = (directory, sessionID) => String(directory) + ":" + String(sessionID)
const clone = (value) => JSON.parse(JSON.stringify(value))
const workspace = {
  buildPrompt: async () => "continue",
  ensureBranch: async (_directory, job) => job,
  watchChanged: async () => false,
  untilReached: async () => false,
  createCheckpoint: async (...args) => checkpoints.push(args),
}
const goalPolicy = {
  runGoalChecks: async (_directory, _sessionID, job) => job,
  applyGoalNoProgressGuard: async (_directory, _client, _sessionID, job) => job,
}
const scheduler = {
  rememberSession: () => {},
  scheduleDueWork: async (...args) => schedules.push(args),
}
const executor = createLoopExecutor({
  workspace,
  goalPolicy,
  scheduler,
  now: () => clock,
  readState: async (directory, sessionID) => clone(states.get(key(directory, sessionID)) || { jobs: [] }),
  writeState: async (directory, sessionID, state) => states.set(key(directory, sessionID), clone(state)),
  appendLoopLog: async () => {},
  runShellCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
  notifyJob: async (...args) => notifications.push(args),
  toast: async (...args) => toasts.push(args),
  fireSdk: () => Promise.resolve({}),
  compactSession: async () => true,
  activeRunCompletionFromMessages: async () => outcome,
  busyRetryMs: 5_000,
})
const client = { session: { status: async () => ({ data: {} }), prompt: async () => ({ data: {} }), abort: async () => ({ data: {} }) } }
const directory = "/repo"
const sessionID = "empty-run"
states.set(key(directory, sessionID), { jobs: [{
  id: "job", name: "job", action: "devam et", enabled: true, paused: false, intervalMs: 0, runCount: 0, maxRuns: 1, maxRuntimeMs: 0, timeoutMs: 0,
}] })

await executor.maybeRunDueJobs(directory, client, sessionID)
assert.equal(states.get(key(directory, sessionID)).jobs[0].runCount, 1)
assert.equal(states.get(key(directory, sessionID)).jobs[0].enabled, false, "max-runs is provisionally consumed at dispatch")
clock += 100
assert.equal(await executor.finalizeActiveRun(directory, client, sessionID), true)
let persisted = states.get(key(directory, sessionID)).jobs[0]
assert.equal(persisted.runCount, 0, "empty completed turn must refund runCount")
assert.equal(persisted.enabled, true, "empty max-runs attempt must be re-enabled")
assert.equal(persisted.emptyTurnCount, 1)
assert.equal(persisted.paused, false)
assert.equal(checkpoints.length, 0, "empty turn must not run successful finalization/checkpoint work")
assert.ok(schedules.some((entry) => entry[2] === sessionID && entry[3] === 5_000), "first empty turn retries with bounded delay")

executor.markSessionStatus(sessionID, "idle", clock)
await executor.maybeRunDueJobs(directory, client, sessionID)
clock += 100
assert.equal(await executor.finalizeActiveRun(directory, client, sessionID), true)
persisted = states.get(key(directory, sessionID)).jobs[0]
assert.equal(persisted.runCount, 0)
assert.equal(persisted.emptyTurnCount, 2)
assert.equal(persisted.paused, true, "second consecutive empty completed turn must fail safe instead of looping forever")
assert.ok(notifications.some((entry) => entry[1]?.id === "job" && entry[2] === "empty_turn"))
assert.ok(toasts.some((entry) => /paused after 2 consecutive completed assistant turns/i.test(String(entry[1]))))

const recoverySession = "empty-then-success"
outcome = "empty"
states.set(key(directory, recoverySession), { jobs: [{
  id: "recover", name: "recover", action: "continue", enabled: true, paused: false, intervalMs: 0, runCount: 0, maxRuns: 0, maxRuntimeMs: 0, timeoutMs: 0,
}] })
await executor.maybeRunDueJobs(directory, client, recoverySession)
clock += 100
await executor.finalizeActiveRun(directory, client, recoverySession)
assert.equal(states.get(key(directory, recoverySession)).jobs[0].emptyTurnCount, 1)
executor.markSessionStatus(recoverySession, "idle", clock)
outcome = "completed"
await executor.maybeRunDueJobs(directory, client, recoverySession)
clock += 100
await executor.finalizeActiveRun(directory, client, recoverySession)
const recovered = states.get(key(directory, recoverySession)).jobs[0]
assert.equal(recovered.emptyTurnCount, 0, "a meaningful completed turn resets the consecutive empty streak")
assert.equal(recovered.lastFailureReason, undefined)
assert.equal(recovered.runCount, 1)
assert.ok(checkpoints.some((entry) => entry[2]?.id === "recover"), "meaningful completion still follows normal finalization")

executor.disposeSession(sessionID)
executor.disposeSession(recoverySession)
clearSessionActivity(sessionID)
clearSessionActivity(recoverySession)
console.log("empty-turn recovery tests passed")
`)

let pkg = read('package.json')
const checkBefore = 'node --check src/source/runtime/network-recovery.js && node --check src/source/runtime/terminal-guard.js'
const checkAfter = 'node --check src/source/runtime/network-recovery.js && node --check src/source/runtime/empty-turn.js && node --check src/source/runtime/terminal-guard.js'
const testCheckBefore = 'node --check scripts/session-status-idle-recovery-test.mjs && node --check scripts/network-recovery-test.mjs'
const testCheckAfter = 'node --check scripts/session-status-idle-recovery-test.mjs && node --check scripts/empty-turn-recovery-test.mjs && node --check scripts/network-recovery-test.mjs'
const testBefore = 'node scripts/session-status-idle-recovery-test.mjs && node scripts/network-recovery-test.mjs'
const testAfter = 'node scripts/session-status-idle-recovery-test.mjs && node scripts/empty-turn-recovery-test.mjs && node scripts/network-recovery-test.mjs'
for (const [before, after] of [[checkBefore, checkAfter], [testCheckBefore, testCheckAfter], [testBefore, testAfter]]) {
  if (!pkg.includes(before)) throw new Error(`missing package script marker: ${before}`)
  pkg = pkg.replace(before, after)
}
write('package.json', pkg)

console.log('empty-turn source patch applied')
