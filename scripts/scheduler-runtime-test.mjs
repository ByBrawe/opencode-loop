import assert from "node:assert/strict"
import { createSchedulerRuntime, jobDueAt, nextDueDelay } from "../src/source/runtime/scheduler.js"

const baseJob = (overrides = {}) => ({
  id: "job-1",
  enabled: true,
  paused: false,
  maxRuns: 0,
  runCount: 0,
  watchPaths: [],
  createdAt: new Date(0).toISOString(),
  intervalMs: 100,
  lastRunAt: 950,
  ...overrides,
})

assert.equal(jobDueAt(baseJob(), 1_000), 1_050)
assert.equal(jobDueAt(baseJob({ intervalMs: 0 }), 1_000), 1_000)
assert.equal(jobDueAt(baseJob({ lastRunAt: 0 }), 1_000), 1_000)
assert.equal(jobDueAt(baseJob({ lastRunAt: 0, immediate: true, createdAt: new Date(900).toISOString(), intervalMs: 200 }), 1_000), 1_000)
assert.equal(jobDueAt(baseJob({ lastRunAt: 0, immediate: false, createdAt: new Date(900).toISOString(), intervalMs: 200 }), 1_000), 1_100)
assert.equal(nextDueDelay({ jobs: [baseJob({ lastRunAt: 0, immediate: false, createdAt: new Date(900).toISOString(), intervalMs: 200 })] }, 1_000), 100)
assert.equal(jobDueAt(baseJob({ paused: true }), 1_000), Infinity)
assert.equal(jobDueAt(baseJob({ enabled: false }), 1_000), Infinity)
assert.equal(jobDueAt(baseJob({ maxRuns: 2, runCount: 2 }), 1_000), Infinity)
assert.equal(jobDueAt(baseJob({ kind: "goal", goalStatus: "completed" }), 1_000), Infinity)
assert.equal(nextDueDelay({ jobs: [baseJob(), baseJob({ paused: true })] }, 1_000), 50)
assert.equal(nextDueDelay({ jobs: [baseJob({ paused: true })] }, 1_000), Infinity)

function fakeTimers() {
  let id = 0
  const timeouts = new Map()
  const intervals = new Map()
  const setTimeout = (fn, ms) => {
    const timer = { id: ++id, fn, ms }
    timeouts.set(timer.id, timer)
    return timer
  }
  const clearTimeout = (timer) => { if (timer) timeouts.delete(timer.id) }
  const setInterval = (fn, ms) => {
    const timer = { id: ++id, fn, ms }
    intervals.set(timer.id, timer)
    return timer
  }
  const clearInterval = (timer) => { if (timer) intervals.delete(timer.id) }
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  const fireTimeout = async (timer) => {
    timeouts.delete(timer.id)
    timer.fn()
    await flush()
  }
  const fireInterval = async (timer) => {
    timer.fn()
    await flush()
  }
  return { timeouts, intervals, setTimeout, clearTimeout, setInterval, clearInterval, fireTimeout, fireInterval }
}

const timers = fakeTimers()
let clock = 1_000
const events = []
const state = { jobs: [baseJob()] }
const client = { name: "fake-client" }
const runtime = createSchedulerRuntime({
  now: () => clock,
  readState: async () => state,
  sessionIsIdle: async () => true,
  finalizeActiveRun: async (_directory, _client, _sessionID, options) => events.push(options?.forceStale ? "heartbeat-finalize" : "finalize"),
  maybeRunDueJobs: async (_directory, _client, _sessionID, options) => events.push(options?.heartbeat ? "heartbeat-run" : "run"),
  appendLoopLog: async () => {},
  toast: async () => {},
  errorMessage: (error) => error?.message || String(error),
  setTimeout: timers.setTimeout,
  clearTimeout: timers.clearTimeout,
  setInterval: timers.setInterval,
  clearInterval: timers.clearInterval,
  idleDebounceMs: 5,
  busyRetryMs: 7,
  minDueTimerMs: 1,
  maxDueTimerMs: 1_000,
  heartbeatMs: 10,
  sessionTtlMs: 1_000,
})

runtime.rememberSession("/workspace", client, "ses-1")
runtime.rememberSession("/workspace", client, "ses-1")
assert.equal(runtime.knownSessionCount(), 1)
assert.equal(timers.intervals.size, 1, "heartbeat must be deduplicated")

runtime.scheduleIdleWork("/workspace", client, "ses-1")
runtime.scheduleIdleWork("/workspace", client, "ses-1")
assert.equal(timers.timeouts.size, 1, "idle timer must replace the previous timer")
const idleTimer = [...timers.timeouts.values()][0]
assert.equal(idleTimer.ms, 5)
await timers.fireTimeout(idleTimer)
assert.deepEqual(events.splice(0), ["finalize", "run"])

await runtime.scheduleDueWork("/workspace", client, "ses-1")
assert.equal(timers.intervals.size, 2, "watchdog should run alongside heartbeat")
const dueTimer = [...timers.timeouts.values()][0]
assert.equal(dueTimer.ms, 50)
await timers.fireTimeout(dueTimer)
assert.deepEqual(events.splice(0), ["finalize", "run"])

const heartbeat = [...timers.intervals.values()].find((timer) => timer.ms === 10)
assert.ok(heartbeat)
await timers.fireInterval(heartbeat)
assert.deepEqual(events.splice(0), ["heartbeat-finalize", "heartbeat-run"])

await runtime.scheduleDueWork("/workspace", client, "ses-1")
assert.ok(timers.timeouts.size > 0)
runtime.clearSessionScheduling("ses-1")
assert.equal(runtime.knownSessionCount(), 0)
assert.equal(timers.timeouts.size, 0)
assert.equal(timers.intervals.size, 0, "clearing the last session should stop watchdog and heartbeat")

const busyTimers = fakeTimers()
let idleChecks = 0
const busyRuntime = createSchedulerRuntime({
  now: () => 2_000,
  readState: async () => ({ jobs: [baseJob({ intervalMs: 0, lastRunAt: 0 })] }),
  sessionIsIdle: async () => (++idleChecks > 1),
  finalizeActiveRun: async () => { throw new Error("finalize should not run while first idle check is busy") },
  maybeRunDueJobs: async () => {},
  appendLoopLog: async () => {},
  toast: async () => {},
  setTimeout: busyTimers.setTimeout,
  clearTimeout: busyTimers.clearTimeout,
  setInterval: busyTimers.setInterval,
  clearInterval: busyTimers.clearInterval,
  idleDebounceMs: 3,
  busyRetryMs: 7,
  minDueTimerMs: 1,
  heartbeatMs: 10,
})

busyRuntime.scheduleIdleWork("/workspace", client, "ses-busy")
const busyIdleTimer = [...busyTimers.timeouts.values()][0]
await busyTimers.fireTimeout(busyIdleTimer)
const retryTimer = [...busyTimers.timeouts.values()][0]
assert.ok(retryTimer)
assert.equal(retryTimer.ms, 7, "busy idle handler should reschedule with busy retry delay")
busyRuntime.clearSessionScheduling("ses-busy")

console.log("scheduler runtime tests passed")
