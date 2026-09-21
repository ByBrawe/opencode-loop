import assert from "node:assert/strict"
import { createLoopExecutor } from "../src/source/runtime/executor.js"
import { clearSessionActivity } from "../src/source/runtime/session-activity.js"

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

let clock = 1_000_000
const directory = "/repo"
const states = new Map()
const logs = []
const toasts = []
const schedules = []
const notifications = []

function stateKey(sessionID) {
  return `${directory}:${sessionID}`
}

function setJob(sessionID, overrides = {}) {
  states.set(stateKey(sessionID), {
    jobs: [{
      id: `${sessionID}-job`,
      name: `${sessionID}-job`,
      action: "devam et",
      enabled: true,
      paused: false,
      intervalMs: 0,
      runCount: 0,
      maxRuns: 0,
      maxRuntimeMs: 0,
      timeoutMs: 0,
      noOverlap: true,
      ...overrides,
    }],
  })
}

const executor = createLoopExecutor({
  workspace: {
    buildPrompt: async (_directory, job) => job.action,
    ensureBranch: async (_directory, job) => job,
    watchChanged: async () => false,
    untilReached: async () => false,
    createCheckpoint: async () => {},
  },
  goalPolicy: {
    runGoalChecks: async (_directory, _sessionID, job) => job,
    applyGoalNoProgressGuard: async (_directory, _client, _sessionID, job) => job,
  },
  scheduler: {
    rememberSession: () => {},
    scheduleDueWork: async (...args) => schedules.push(args),
  },
  now: () => clock,
  readState: async (_directory, sessionID) => clone(states.get(stateKey(sessionID)) || { jobs: [] }),
  writeState: async (_directory, sessionID, state) => states.set(stateKey(sessionID), clone(state)),
  appendLoopLog: async (...args) => logs.push(args),
  notifyJob: async (...args) => notifications.push(args),
  toast: async (...args) => toasts.push(args),
  runShellCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
  fireSdk: async () => ({ data: {} }),
  sdkCall: async () => ({}),
  normalizedModelRef: () => undefined,
  compactTuiCommandName: () => undefined,
  guardLoopOwnedUserMessage: () => {},
  dangerousShell: () => false,
  activeRunCompletionFromMessages: async () => "unknown",
  busyRetryMs: 5_000,
  networkRetryMaxMs: 60_000,
})

const client = {
  session: {
    status: async () => ({ data: {} }),
    prompt: async () => ({ data: {} }),
    abort: async () => ({ data: {} }),
  },
}

{
  const sessionID = "policy-error"
  setJob(sessionID)
  await executor.maybeRunDueJobs(directory, client, sessionID)
  assert.ok(executor.getActiveRun(sessionID))
  assert.equal(states.get(stateKey(sessionID)).jobs[0].runCount, 1)

  const handled = await executor.handleSessionError(directory, client, {
    type: "session.error",
    properties: {
      sessionID,
      error: {
        name: "APIError",
        data: {
          message: "OpenCode's free tier can only be used from within OpenCode",
          statusCode: 403,
          isRetryable: false,
        },
      },
    },
  })

  assert.equal(handled, true)
  assert.equal(executor.getActiveRun(sessionID), undefined)
  const job = states.get(stateKey(sessionID)).jobs[0]
  assert.equal(job.paused, true, "terminal provider policy error must pause an infinite idle loop")
  assert.equal(job.failureCount, 1)
  assert.equal(job.lastFailureReason, "session_error")
  assert.equal(job.lastSessionErrorName, "APIError")
  assert.equal(job.lastSessionError, "OpenCode's free tier can only be used from within OpenCode")
  assert.equal(job.lastSessionErrorAt, clock)
  assert.ok(notifications.some((call) => call[1]?.id === job.id && call[2] === "session_error"))
  assert.ok(logs.some((call) => call[1] === "session-error" && call[2]?.sessionID === sessionID && call[2]?.paused === true))
  assert.ok(toasts.some((call) => String(call[1]).includes("Loop paused after a terminal OpenCode session error")))

  await executor.maybeRunDueJobs(directory, client, sessionID)
  assert.equal(states.get(stateKey(sessionID)).jobs[0].runCount, 1, "paused terminal-error job must not immediately dispatch another run")
}

{
  const sessionID = "retryable-provider-error"
  setJob(sessionID, { maxRuns: 1 })
  await executor.maybeRunDueJobs(directory, client, sessionID)
  let job = states.get(stateKey(sessionID)).jobs[0]
  assert.equal(job.runCount, 1)
  assert.equal(job.enabled, false, "max-runs may disable while the provider turn is in flight")

  clock += 10
  const handled = await executor.handleSessionError(directory, client, {
    type: "session.error",
    properties: {
      sessionID,
      error: {
        name: "APIError",
        data: {
          message: "provider temporarily unavailable",
          statusCode: 503,
          isRetryable: true,
        },
      },
    },
  })

  assert.equal(handled, true)
  assert.equal(executor.getActiveRun(sessionID), undefined)
  job = states.get(stateKey(sessionID)).jobs[0]
  assert.equal(job.runCount, 0, "retryable terminal provider error must refund the logical run")
  assert.equal(job.enabled, true, "refunded max-runs disable must be rolled back")
  assert.equal(job.paused, false)
  assert.equal(job.failureCount || 0, 0, "retryable provider outage must not consume ordinary failure budget")
  assert.equal(job.infrastructureFailureCount, 1)
  assert.equal(job.lastInfrastructureFailure, "session_error_retryable")
  assert.match(job.lastInfrastructureError, /provider temporarily unavailable/)
  assert.ok(logs.some((call) => call[1] === "provider-session-error-retry" && call[2]?.sessionID === sessionID))
  assert.ok(schedules.some((call) => call[2] === sessionID && call[3] >= 5_000))
}

{
  const sessionID = "user-abort"
  setJob(sessionID)
  await executor.maybeRunDueJobs(directory, client, sessionID)
  const active = executor.getActiveRun(sessionID)
  assert.ok(active)

  const handled = await executor.handleSessionError(directory, client, {
    type: "session.error",
    properties: {
      sessionID,
      error: {
        name: "MessageAbortedError",
        data: { message: "The operation was aborted." },
      },
    },
  })

  assert.equal(handled, false, "user/session abort must keep existing abort/finalization semantics")
  assert.strictEqual(executor.getActiveRun(sessionID), active)
}

for (const sessionID of ["policy-error", "retryable-provider-error", "user-abort"]) {
  executor.disposeSession(sessionID)
  clearSessionActivity(sessionID)
}

console.log("session error recovery tests passed")
