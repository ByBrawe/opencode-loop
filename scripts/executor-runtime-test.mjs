import assert from "node:assert/strict"
import { createLoopExecutor } from "../src/source/runtime/executor.js"
import { clearSessionActivity } from "../src/source/runtime/session-activity.js"

const noopWorkspace = {
  buildPrompt: async () => "prompt",
  ensureBranch: async (_directory, job) => job,
  watchChanged: async () => false,
  untilReached: async () => false,
  createCheckpoint: async () => {},
}
const noopGoalPolicy = {
  runGoalChecks: async (_directory, _sessionID, job) => job,
  applyGoalNoProgressGuard: async (_directory, _client, _sessionID, job) => job,
}
const noopScheduler = {
  rememberSession: () => {},
  scheduleDueWork: async () => {},
}

assert.throws(() => createLoopExecutor({}), /workspace\.buildPrompt/)
assert.throws(() => createLoopExecutor({ workspace: noopWorkspace }), /goalPolicy\.runGoalChecks/)
assert.throws(() => createLoopExecutor({ workspace: noopWorkspace, goalPolicy: noopGoalPolicy }), /scheduler\.rememberSession/)

let clock = 1_000_000
const states = new Map()
const writes = []
const schedules = []
const remembered = []
const toasts = []
const logs = []
const notifications = []
const guards = []
const sdkCalls = []
const fireCalls = []
const compactions = []
const checkpoints = []
const branchCalls = []
const goalChecks = []
const progressGuards = []

function stateKey(directory, sessionID) {
  return `${directory}:${sessionID}`
}
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

const workspace = {
  buildPrompt: async (_directory, job) => `BUILT:${job.action}`,
  ensureBranch: async (_directory, job, _client, sessionID) => {
    branchCalls.push([sessionID, job.id])
    return { ...job, branchDone: true }
  },
  watchChanged: async (_directory, job) => Boolean(job.testWatchChanged),
  untilReached: async (_directory, job) => Boolean(job.testUntilReached),
  createCheckpoint: async (...args) => { checkpoints.push(args) },
}
const goalPolicy = {
  runGoalChecks: async (_directory, sessionID, job) => {
    goalChecks.push([sessionID, job.id])
    return { ...job, goalChecksRan: true }
  },
  applyGoalNoProgressGuard: async (_directory, _client, sessionID, job) => {
    progressGuards.push([sessionID, job.id])
    return { ...job, noProgressGuardRan: true }
  },
}
const scheduler = {
  rememberSession: (...args) => { remembered.push(args) },
  scheduleDueWork: async (...args) => { schedules.push(args) },
}

const executor = createLoopExecutor({
  workspace,
  goalPolicy,
  scheduler,
  now: () => clock,
  readState: async (directory, sessionID) => clone(states.get(stateKey(directory, sessionID)) || { jobs: [] }),
  writeState: async (directory, sessionID, state) => {
    const copy = clone(state)
    states.set(stateKey(directory, sessionID), copy)
    writes.push([directory, sessionID, copy])
  },
  pathExists: async (file) => String(file).includes("STOP-NOW"),
  appendLoopLog: async (...args) => { logs.push(args) },
  runShellCommand: async (command) => command.includes("fail")
    ? { code: 1, stdout: "bad", stderr: "err" }
    : { code: 0, stdout: "ok", stderr: "" },
  notifyJob: async (...args) => { notifications.push(args) },
  toast: async (...args) => { toasts.push(args) },
  log: async (...args) => { logs.push(["host", ...args]) },
  sdkCall: async (...args) => { sdkCalls.push(args); return {} },
  normalizedModelRef: () => undefined,
  compactTuiCommandName: (command) => command === "compact" ? "compact" : undefined,
  fireSdk: (...args) => { fireCalls.push(args); return Promise.resolve({ ok: true }) },
  guardLoopOwnedUserMessage: (sessionID) => { guards.push(sessionID) },
  writeGoalReport: async (...args) => { logs.push(["goal-report", ...args]) },
  dangerousShell: (command) => /danger/.test(command),
  compactSession: async (...args) => { compactions.push(args); return true },
  activeRunCompletionFromMessages: async () => "unknown",
  activeGuardMs: 45_000,
  busyRetryMs: 5_000,
})

const dueState = {
  jobs: [
    { id: "disabled", enabled: false, intervalMs: 0 },
    { id: "paused", enabled: true, paused: true, intervalMs: 0 },
    { id: "maxed", enabled: true, maxRuns: 1, runCount: 1, intervalMs: 0 },
    { id: "watch-no", enabled: true, watchPaths: ["x"], watchTriggered: false, intervalMs: 0 },
    { id: "watch-yes", enabled: true, watchPaths: ["x"], watchTriggered: true, intervalMs: 99_999 },
    { id: "interval", enabled: true, intervalMs: 10_000, lastRunAt: clock - 20_000 },
  ],
}
assert.deepEqual(executor.dueJobs(dueState).map((job) => job.id), ["watch-yes", "interval"])
assert.deepEqual(executor.dueJobs(dueState, true).map((job) => job.id), ["watch-no", "watch-yes", "interval"])

const client = {
  session: {
    status: async () => ({ data: {} }),
    command: async () => ({ data: {} }),
    shell: async () => ({ data: {} }),
    prompt: async () => ({ data: {} }),
    abort: async () => ({ data: {} }),
  },
}

const blockedShell = await executor.fireAction("/repo", client, "shell-session", {
  id: "shell-job",
  action: "! danger --all",
  safe: true,
})
assert.deepEqual(blockedShell, { startsAssistantTurn: false, pause: true, reason: "safe_shell_blocked" })
assert.equal(fireCalls.length, 0)
assert.match(toasts.at(-1)[1], /Blocked dangerous shell command/)

const commandResult = await executor.fireAction("/repo", client, "command-session", {
  id: "command-job",
  action: "/review --quick",
  agent: "build",
})
assert.deepEqual(commandResult, { startsAssistantTurn: true })
assert.equal(sdkCalls.length, 1)
assert.equal(guards.at(-1), "command-session")

const compactResult = await executor.fireAction("/repo", client, "compact-session", {
  id: "compact-job",
  action: "/compact",
})
assert.equal(compactResult.startsAssistantTurn, true)
assert.equal(compactResult.compaction, true)
assert.equal(compactions.length, 1)

const promptResult = await executor.fireAction("/repo", client, "prompt-session", {
  id: "prompt-job",
  action: "continue work",
  enabled: true,
})
assert.equal(promptResult.startsAssistantTurn, true)
assert.ok(promptResult.dispatch instanceof Promise)
assert.equal(fireCalls.at(-1)[1], "session.prompt")
const promptBody = fireCalls.at(-1)[3].body
assert.match(promptBody.parts[0].text, /AUTONOMOUS OPENCODE LOOP ITERATION/)
assert.match(promptBody.parts[0].text, /BUILT:continue work/)

const sessionID = "run-session"
const directory = "/repo"
states.set(stateKey(directory, sessionID), {
  jobs: [{
    id: "run-job",
    name: "run-job",
    action: "implement feature",
    enabled: true,
    paused: false,
    intervalMs: 0,
    runCount: 0,
    maxRuns: 0,
    maxRuntimeMs: 0,
    timeoutMs: 0,
    safe: false,
  }],
})
await executor.maybeRunDueJobs(directory, client, sessionID)
assert.equal(remembered.at(-1)[2], sessionID)
const active = executor.getActiveRun(sessionID)
assert.equal(active.jobId, "run-job")
assert.equal(active.job.runCount, 1)
assert.equal(executor.isRunLocked(sessionID), false)
assert.equal(states.get(stateKey(directory, sessionID)).jobs[0].runCount, 1)
assert.ok(schedules.some((call) => call[2] === sessionID && call[3] === 5_000))
assert.ok(branchCalls.some((call) => call[0] === sessionID && call[1] === "run-job"))

clock += 1_000
const finalized = await executor.finalizeActiveRun(directory, client, sessionID)
assert.equal(finalized, true)
assert.equal(executor.getActiveRun(sessionID), undefined)
assert.equal(states.get(stateKey(directory, sessionID)).jobs[0].lastFinishedAt, clock)
assert.ok(checkpoints.some((call) => call[2].id === "run-job"))

const goalSession = "goal-session"
states.set(stateKey(directory, goalSession), {
  jobs: [{
    id: "goal-job",
    name: "goal-job",
    kind: "goal",
    goal: "finish",
    goalStatus: "active",
    action: "finish",
    enabled: true,
    paused: false,
    intervalMs: 0,
    runCount: 0,
    maxRuns: 0,
    maxRuntimeMs: 0,
    timeoutMs: 0,
  }],
})
await executor.maybeRunDueJobs(directory, client, goalSession)
clock += 1_000
await executor.finalizeActiveRun(directory, client, goalSession)
assert.deepEqual(goalChecks.at(-1), [goalSession, "goal-job"])
assert.deepEqual(progressGuards.at(-1), [goalSession, "goal-job"])
const finalizedGoal = states.get(stateKey(directory, goalSession)).jobs[0]
assert.equal(finalizedGoal.goalChecksRan, true)
assert.equal(finalizedGoal.noProgressGuardRan, true)

const stopSession = "stop-session"
states.set(stateKey(directory, stopSession), {
  jobs: [{
    id: "stop-job",
    enabled: true,
    paused: false,
    intervalMs: 0,
    maxRuns: 0,
    maxRuntimeMs: 0,
    stopFile: "STOP-NOW",
  }],
})
await executor.maybeRunDueJobs(directory, client, stopSession)
assert.equal(states.get(stateKey(directory, stopSession)).jobs.length, 0)
assert.ok(notifications.some((call) => call[1]?.id === "stop-job" && call[2] === "stop_file"))

executor.disposeSession(sessionID)
executor.disposeSession(goalSession)
executor.disposeSession(stopSession)
for (const id of ["shell-session", "command-session", "compact-session", "prompt-session", sessionID, goalSession, stopSession]) {
  clearSessionActivity(id)
}

assert.ok(writes.length > 0)
console.log("executor runtime tests passed")
