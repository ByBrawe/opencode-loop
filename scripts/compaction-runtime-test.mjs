import assert from "node:assert/strict"
import { createCompactionRuntime } from "../src/source/runtime/compaction.js"

assert.throws(() => createCompactionRuntime({}), /activeRuns Map/)
assert.throws(() => createCompactionRuntime({ activeRuns: new Map() }), /finalizeActiveRun/)

let clock = 10_000
const activeRuns = new Map()
const compactCalls = []
const compactResults = []
const logs = []
const hostLogs = []
const finalizeCalls = []

const runtime = createCompactionRuntime({
  activeRuns,
  now: () => clock,
  compactSession: async (...args) => {
    compactCalls.push(args)
    return compactResults.shift() ?? true
  },
  appendLoopLog: async (...args) => { logs.push(args) },
  finalizeActiveRun: async (...args) => {
    finalizeCalls.push(args)
    return true
  },
  log: async (...args) => { hostLogs.push(args) },
  errorMessage: (error) => `ERR:${error?.message || error}`,
})

assert.equal(runtime.getPending("s"), undefined)
assert.equal(runtime.begin(undefined, "job"), undefined)
assert.equal(runtime.begin("s", undefined), undefined)

const first = runtime.begin("s", "job-1", true)
assert.deepEqual(first, {
  jobId: "job-1",
  resumeAfter: true,
  requestedAt: 10_000,
  startedAt: 0,
  completedAt: 0,
})
assert.equal(runtime.getPending("s"), first)
assert.equal(runtime.isCompleted("s", "job-1"), false)
assert.equal(runtime.clear("s"), true)
assert.equal(runtime.getPending("s"), undefined)

runtime.begin("s", "job-1")
runtime.clearForActiveRun("s", { jobId: "other" })
assert.equal(runtime.getPending("s")?.jobId, "job-1")
runtime.clearForActiveRun("s", { jobId: "job-1" })
assert.equal(runtime.getPending("s"), undefined)
runtime.begin("s", "job-1")
runtime.clearForActiveRun("s", undefined)
assert.equal(runtime.getPending("s"), undefined)

const idleJob = { id: "idle", compactEveryRuns: 0, compactEveryMs: 0, runCount: 0 }
assert.deepEqual(await runtime.maybeCompact("/repo", {}, "s", idleJob), { job: idleJob, started: false })
assert.equal(compactCalls.length, 0)

const runJob = { id: "runs", compactEveryRuns: 2, compactEveryMs: 0, runCount: 2, lastCompactRunCount: 0, model: "m" }
compactResults.push(true)
clock = 20_000
const runResult = await runtime.maybeCompact("/repo", { id: "client" }, "s", runJob)
assert.equal(runResult.started, true)
assert.equal(runJob.lastCompactAt, 20_000)
assert.equal(runJob.lastCompactRunCount, 2)
assert.equal(runtime.getPending("s")?.resumeAfter, true)
assert.deepEqual(compactCalls.at(-1), ["/repo", { id: "client" }, "s", "m"])

const beforeStartLogs = logs.length
clock = 21_000
assert.equal(await runtime.noteStarted("/repo", "s"), true)
assert.equal(runtime.getPending("s").startedAt, 21_000)
assert.deepEqual(logs.at(-1), ["/repo", "compact-started", { sessionID: "s", job: "runs", resumeAfter: true }])
assert.equal(await runtime.noteStarted("/repo", "s"), true)
assert.equal(logs.length, beforeStartLogs + 1)

activeRuns.set("s", { jobId: "other" })
assert.equal(await runtime.finalize("/repo", {}, "s"), false)
activeRuns.set("s", { jobId: "runs" })
assert.equal(await runtime.finalize("/repo", { id: "client" }, "s"), true)
assert.deepEqual(finalizeCalls.at(-1), ["/repo", { id: "client" }, "s"])

clock = 22_000
assert.equal(await runtime.noteCompleted("/repo", { id: "client" }, "s"), true)
assert.equal(runtime.getPending("s").completedAt, 22_000)
assert.equal(runtime.isCompleted("s", "runs"), true)
assert.deepEqual(logs.at(-1), ["/repo", "compact-event", { sessionID: "s", job: "runs", resumeAfter: true }])
await new Promise((resolve) => setTimeout(resolve, 20))
assert.ok(finalizeCalls.length >= 2)

runtime.clear("s")
assert.equal(await runtime.noteStarted("/repo", "s"), false)
assert.equal(await runtime.noteCompleted("/repo", {}, "s"), false)
assert.equal(await runtime.finalize("/repo", {}, "s"), false)

const failedJob = { id: "failed", compactEveryRuns: 1, compactEveryMs: 0, runCount: 1, model: undefined }
compactResults.push(false)
clock = 30_000
const failedResult = await runtime.maybeCompact("/repo", {}, "failed-session", failedJob)
assert.equal(failedResult.started, false)
assert.equal(runtime.getPending("failed-session"), undefined)
assert.equal(failedJob.lastCompactAt, undefined)

const timeJob = { id: "time", compactEveryRuns: 0, compactEveryMs: 500, runCount: 7, lastCompactAt: 39_000 }
compactResults.push(true)
clock = 40_000
assert.equal((await runtime.maybeCompact("/repo", {}, "time-session", timeJob)).started, true)
assert.equal(timeJob.lastCompactAt, 40_000)
assert.equal(timeJob.lastCompactRunCount, 7)

const errorActiveRuns = new Map([["err", { jobId: "error-job" }]])
const errorLogs = []
const errorRuntime = createCompactionRuntime({
  activeRuns: errorActiveRuns,
  now: () => 50_000,
  appendLoopLog: async () => {},
  finalizeActiveRun: async () => { throw new Error("boom") },
  log: async (...args) => { errorLogs.push(args) },
  errorMessage: (error) => `wrapped:${error.message}`,
})
errorRuntime.begin("err", "error-job")
await errorRuntime.noteCompleted("/repo", { id: "client" }, "err")
await new Promise((resolve) => setTimeout(resolve, 20))
assert.deepEqual(errorLogs.at(-1), [{ id: "client" }, "error", "compaction finalization failed", { error: "wrapped:boom" }])

console.log("compaction runtime tests passed")
