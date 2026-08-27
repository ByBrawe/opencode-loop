import assert from "node:assert/strict"
import { activeRunCompletionFromMessages, assistantMessageHasMeaningfulActivity } from "../src/source/opencode/host.js"
import { createSessionStatusRuntime } from "../src/source/runtime/session-status.js"
import { createLoopExecutor } from "../src/source/runtime/executor.js"
import { refundEmptyAssistantTurn, clearEmptyAssistantTurnStreak } from "../src/source/runtime/empty-turn.js"
import { clearSessionActivity } from "../src/source/runtime/session-activity.js"

const blank = { info: { role: "assistant", time: { created: 120, completed: 130 } }, parts: [] }
const whitespace = { info: { role: "assistant", time: { created: 120, completed: 130 } }, parts: [{ type: "text", text: "   \n" }] }
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
