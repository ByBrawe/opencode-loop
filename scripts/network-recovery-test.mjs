import assert from "node:assert/strict"
import { isCompletionBoundedContinuation, isTerminalNoWorkReply } from "../src/source/core/continuation.js"
import { isTransientNetworkError, networkRetryDelayMs, refundInfrastructureRun } from "../src/source/runtime/network-recovery.js"
import { createSessionStatusRuntime } from "../src/source/runtime/session-status.js"
import { applyTerminalContinuationGuard } from "../src/source/runtime/terminal-guard.js"
import { createLoopExecutor } from "../src/source/runtime/executor.js"
import { clearSessionActivity, sessionStatuses, sessionStatusSeenAt } from "../src/source/runtime/session-activity.js"

function clone(value) { return JSON.parse(JSON.stringify(value)) }

for (const value of [
  "fetch failed",
  "network connection lost",
  "ECONNRESET",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "socket hang up",
  "HTTP 503 service unavailable",
]) assert.equal(isTransientNetworkError(value), true, value)
assert.equal(isTransientNetworkError("HTTP 401 invalid API key"), false)
assert.equal(networkRetryDelayMs(1, 5_000, 60_000), 5_000)
assert.equal(networkRetryDelayMs(2, 5_000, 60_000), 10_000)
assert.equal(networkRetryDelayMs(9, 5_000, 60_000), 60_000)

const refunded = {
  id: "limited",
  runCount: 3,
  maxRuns: 3,
  enabled: false,
  lastRunAt: 500,
  failureCount: 2,
}
refundInfrastructureRun(refunded, {
  runCount: 3,
  previousLastRunAt: 250,
  disabledByMaxRuns: true,
}, {
  reason: "dispatch_failed_transient",
  error: new Error("fetch failed: ECONNRESET"),
  now: 1_000,
})
assert.equal(refunded.runCount, 2, "transient infrastructure attempt must not consume max-runs")
assert.equal(refunded.enabled, true, "max-runs disable caused by a transient attempt must be rolled back")
assert.equal(refunded.lastRunAt, 250)
assert.equal(refunded.failureCount, 2, "transient outage must not consume ordinary failure budget")
assert.equal(refunded.infrastructureFailureCount, 1)

{
  let clock = 100_000
  const activeRuns = new Map([["retry-session", { startedAt: 1, jobId: "j", job: { id: "j" } }]])
  const logs = []
  const runtime = createSessionStatusRuntime({
    activeRuns,
    now: () => clock,
    staleActiveRecoveryMs: 1_000,
    sessionStatusCacheMs: 0,
    activeRunCompletionFromMessages: async () => "unknown",
    appendLoopLog: async (...args) => logs.push(args),
  })
  const retryClient = { session: { status: async () => ({ data: { "retry-session": { type: "retry" } } }) } }
  assert.equal(await runtime.sessionStatusType(retryClient, "retry-session", "/repo"), "retry")
  clock += 120_000
  assert.equal(await runtime.sessionStatusType(retryClient, "retry-session", "/repo"), "retry", "stale retry must never be converted to idle by age alone")
  assert.equal(logs.some((entry) => entry[1] === "status-stale-recovery"), false)
  clearSessionActivity("retry-session")
  sessionStatuses.delete("retry-session")
  sessionStatusSeenAt.delete("retry-session")
}

{
  let clock = 100_000
  const activeRuns = new Map([["offline-session", { startedAt: 1, jobId: "j", job: { id: "j" } }]])
  const runtime = createSessionStatusRuntime({
    activeRuns,
    now: () => clock,
    staleActiveRecoveryMs: 1_000,
    sessionStatusCacheMs: 0,
    activeRunCompletionFromMessages: async () => "unknown",
    appendLoopLog: async () => {},
  })
  const offlineClient = { session: { status: async () => { throw new Error("network connection lost") } } }
  clock += 120_000
  assert.equal(await runtime.sessionStatusType(offlineClient, "offline-session", "/repo"), "busy", "failed status reads must fail closed, not become idle")
  clearSessionActivity("offline-session")
  sessionStatuses.delete("offline-session")
  sessionStatusSeenAt.delete("offline-session")
}

assert.equal(isCompletionBoundedContinuation("devam et"), false)
assert.equal(isCompletionBoundedContinuation("devam et bitene kadar devam tamamen projeyi bitir"), true)
assert.equal(isTerminalNoWorkReply("Proje tamamlandı — 28/28 test yeşil. Yapılacak iş yok. Sıfır bilinen hata."), true)
assert.equal(isTerminalNoWorkReply("Proje tamamlandı ama sıradaki iş build doğrulaması."), false)

{
  const terminalMessages = [{
    info: { role: "assistant", time: { created: 2_000, completed: 2_100 } },
    parts: [{ type: "text", text: "Proje tamamlandı — 28/28 test yeşil. Yapılacak iş yok. Sıfır bilinen hata." }],
  }]
  const client = { session: { messages: async () => ({ data: terminalMessages }) } }
  const bounded = {
    id: "bounded",
    action: "devam et bitene kadar devam tamamen projeyi bitir",
    scheduleMode: "idle",
    lastRunAt: 1_500,
    paused: false,
  }
  let result = await applyTerminalContinuationGuard("/repo", client, "s", bounded)
  assert.equal(result.terminal, true)
  assert.equal(result.pausedNow, false)
  assert.equal(result.job.terminalNoWorkCount, 1)
  result = await applyTerminalContinuationGuard("/repo", client, "s", result.job)
  assert.equal(result.pausedNow, true, "two current terminal replies should stop an explicit until-done loop")
  assert.equal(result.job.paused, true)

  const infinite = {
    id: "infinite",
    action: "devam et",
    scheduleMode: "idle",
    lastRunAt: 1_500,
    paused: false,
  }
  const untouched = await applyTerminalContinuationGuard("/repo", client, "s", infinite)
  assert.equal(untouched.terminal, false)
  assert.equal(untouched.job.paused, false, "plain /loop devam et must remain intentionally infinite")
}

{
  let clock = 1_000_000
  let liveStatus = "idle"
  const states = new Map()
  const schedules = []
  const fireCalls = []
  const directory = "/repo"
  const sessionID = "watchdog-session"
  const stateKey = `${directory}:${sessionID}`
  states.set(stateKey, { jobs: [{
    id: "job",
    name: "job",
    action: "devam et",
    scheduleMode: "idle",
    enabled: true,
    paused: false,
    intervalMs: 0,
    runCount: 0,
    maxRuns: 1,
    maxRuntimeMs: 0,
    timeoutMs: 0,
    noOverlap: true,
  }] })

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
    readState: async () => clone(states.get(stateKey)),
    writeState: async (_directory, _sessionID, state) => states.set(stateKey, clone(state)),
    appendLoopLog: async () => {},
    notifyJob: async () => {},
    toast: async () => {},
    runShellCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    fireSdk: (...args) => { fireCalls.push(args); return Promise.resolve({ data: {} }) },
    sdkCall: async () => ({}),
    normalizedModelRef: () => undefined,
    compactTuiCommandName: () => undefined,
    guardLoopOwnedUserMessage: () => {},
    dangerousShell: () => false,
    activeRunCompletionFromMessages: async () => "unknown",
    busyRetryMs: 5,
    providerRetryWatchdogMs: 20,
    networkRetryMaxMs: 100,
  })

  const client = {
    session: {
      status: async () => ({ data: liveStatus === "idle" ? {} : { [sessionID]: { type: liveStatus } } }),
      prompt: async () => ({ data: {} }),
      abort: async () => ({ data: {} }),
    },
  }

  await executor.maybeRunDueJobs(directory, client, sessionID)
  assert.ok(executor.getActiveRun(sessionID), "first logical run should be active")
  assert.equal(states.get(stateKey).jobs[0].runCount, 1)
  assert.equal(states.get(stateKey).jobs[0].enabled, false, "max-runs can temporarily disable while the real turn is in flight")

  liveStatus = "retry"
  clock += 5
  await executor.maybeRunDueJobs(directory, client, sessionID)
  assert.ok(executor.getActiveRun(sessionID), "first retry observation should remain host-owned")
  clock += 25
  await executor.maybeRunDueJobs(directory, client, sessionID)

  assert.equal(executor.getActiveRun(sessionID), undefined, "stuck Loop-owned retry should be released after watchdog")
  const job = states.get(stateKey).jobs[0]
  assert.equal(job.runCount, 0, "network watchdog recovery must refund the logical run")
  assert.equal(job.enabled, true, "refunded max-runs job should be runnable again")
  assert.equal(job.infrastructureFailureCount, 1)
  assert.ok(fireCalls.some((call) => String(call[1]).includes("provider retry watchdog")), "watchdog must abort only the Loop-owned stuck turn")
  assert.ok(schedules.some((call) => call[3] >= 5), "recovery must reschedule with backoff")
  clearSessionActivity(sessionID)
  sessionStatuses.delete(sessionID)
  sessionStatusSeenAt.delete(sessionID)
}

console.log("network recovery + terminal continuation guard: ok")
