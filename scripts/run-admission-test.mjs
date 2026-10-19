import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { createRunAdmissionRuntime } from "../src/source/runtime/run-admission.js"
import { inspectTaskChecklist } from "../src/source/runtime/checklist-completion.js"

assert.throws(() => createRunAdmissionRuntime({}), /untilReached/)
assert.throws(() => createRunAdmissionRuntime({ untilReached: async () => false }), /scheduleDueWork/)

let clock = 1_000_000
const writes = []
const logs = []
const shellCalls = []
const notifications = []
const toasts = []
const schedules = []
const stopFiles = new Set()
const untilJobs = new Set()
const normalizePath = (value) => String(value).replace(/\\/g, "/")

const runtime = createRunAdmissionRuntime({
  untilReached: async (_directory, job) => untilJobs.has(job.id),
  scheduleDueWork: async (...args) => { schedules.push(args) },
  now: () => clock,
  pathExists: async (target) => stopFiles.has(normalizePath(target)),
  writeState: async (...args) => { writes.push(args) },
  appendLoopLog: async (...args) => { logs.push(args) },
  runShellCommand: async (command) => {
    shellCalls.push(command)
    if (command.includes("fail")) return { code: 7, stdout: "bad", stderr: "preflight error" }
    return { code: 0, stdout: "ok", stderr: "" }
  },
  notifyJob: async (...args) => { notifications.push(args) },
  toast: async (...args) => { toasts.push(args) },
  dangerousShell: (command) => command.includes("danger"),
})

const dueState = {
  jobs: [
    { id: "disabled", enabled: false, intervalMs: 0 },
    { id: "paused", enabled: true, paused: true, intervalMs: 0 },
    { id: "maxed", enabled: true, maxRuns: 1, runCount: 1, intervalMs: 0 },
    { id: "goal-done", kind: "goal", goalStatus: "completed", enabled: true, intervalMs: 0 },
    { id: "watch-no", enabled: true, watchPaths: ["x"], watchTriggered: false, intervalMs: 0 },
    { id: "watch-yes", enabled: true, watchPaths: ["x"], watchTriggered: true, intervalMs: 99_999 },
    { id: "interval", enabled: true, intervalMs: 10_000, lastRunAt: clock - 20_000 },
    { id: "run-now", enabled: true, intervalMs: 999_999, lastRunAt: clock, runNowRequestedAt: clock },
  ],
}
assert.deepEqual(runtime.dueJobs(dueState).map((job) => job.id), ["run-now", "watch-yes", "interval"])
assert.deepEqual(runtime.dueJobs(dueState, true).map((job) => job.id), ["run-now", "watch-no", "watch-yes", "interval"])

const expired = {
  id: "expired",
  name: "expired-job",
  enabled: true,
  createdAt: new Date(clock - 20_000).toISOString(),
  maxRuntimeMs: 10_000,
}
const expiredState = { jobs: [expired, { id: "keep", enabled: true }] }
const expiredResult = await runtime.admitJob("/repo", {}, "session-expired", expiredState, expired)
assert.deepEqual(expiredResult, { admitted: false, reason: "max_runtime_reached" })
assert.deepEqual(expiredState.jobs.map((job) => job.id), ["keep"])
assert.equal(notifications.at(-1)[2], "max_runtime_reached")
assert.equal(logs.at(-1)[1], "max-runtime")
assert.match(toasts.at(-1)[1], /--max-runtime/)
assert.equal(schedules.at(-1)[2], "session-expired")

stopFiles.add(normalizePath(path.resolve("/repo", "STOP")))
const stopped = { id: "stopped", enabled: true, stopFile: "STOP" }
const stoppedState = { jobs: [stopped] }
const stoppedResult = await runtime.admitJob("/repo", {}, "session-stop", stoppedState, stopped)
assert.deepEqual(stoppedResult, { admitted: false, reason: "stop_file" })
assert.equal(stoppedState.jobs.length, 0)
assert.equal(notifications.at(-1)[2], "stop_file")
assert.match(toasts.at(-1)[1], /--stop-file/)

untilJobs.add("until-job")
const untilJob = { id: "until-job", enabled: true, until: "DONE" }
const untilState = { jobs: [untilJob] }
const untilResult = await runtime.admitJob("/repo", {}, "session-until", untilState, untilJob)
assert.deepEqual(untilResult, { admitted: false, reason: "until_reached" })
assert.equal(untilState.jobs.length, 0)
assert.equal(notifications.at(-1)[2], "until_reached")
assert.match(toasts.at(-1)[1], /--until/)

const blocked = {
  id: "blocked-preflight",
  enabled: true,
  safe: true,
  preflightCommand: "danger --all",
  runNowRequestedAt: clock,
}
const blockedState = { jobs: [blocked] }
const shellCountBeforeBlock = shellCalls.length
const blockedResult = await runtime.admitJob("/repo", {}, "session-blocked", blockedState, blocked)
assert.deepEqual(blockedResult, { admitted: false, reason: "preflight_blocked" })
assert.equal(shellCalls.length, shellCountBeforeBlock)
assert.equal(blocked.paused, true)
assert.equal(blocked.runNowRequestedAt, undefined)
assert.equal(notifications.at(-1)[2], "preflight_blocked")
assert.equal(writes.at(-1)[2], blockedState)

const failed = {
  id: "failed-preflight",
  enabled: true,
  preflightCommand: "preflight-fail",
  runNowRequestedAt: clock,
  failureCount: 2,
}
const failedState = { jobs: [failed] }
const failedResult = await runtime.admitJob("/repo", {}, "session-failed", failedState, failed)
assert.deepEqual(failedResult, { admitted: false, reason: "preflight_failed" })
assert.equal(failed.paused, true)
assert.equal(failed.failureCount, 3)
assert.equal(failed.runNowRequestedAt, undefined)
assert.match(failed.lastPreflightFailure, /exit=7/)
assert.match(failed.lastPreflightFailure, /preflight error/)
assert.equal(logs.findLast((entry) => entry[1] === "preflight")?.[2].code, 7)
assert.equal(notifications.at(-1)[2], "preflight_failed")

const admitted = {
  id: "admitted",
  enabled: true,
  preflightCommand: "preflight-ok",
  runNowRequestedAt: clock,
}
const admittedState = { jobs: [admitted] }
const admittedResult = await runtime.admitJob("/repo", {}, "session-admitted", admittedState, admitted)
assert.deepEqual(admittedResult, { admitted: true, job: admitted, runNowRequested: true })
assert.equal(admitted.paused, undefined)
assert.equal(admitted.runNowRequestedAt, clock)
assert.equal(logs.findLast((entry) => entry[1] === "preflight")?.[2].code, 0)

const project = await mkdtemp(path.join(os.tmpdir(), "loop-admission-checklist-"))
try {
  await writeFile(path.join(project, "TASK.md"), "- [ ] code\n- [x] plan\n")
  const checklistJob = { id: "checklist-job", enabled: true, progressFile: "TASK.md", untilChecklistComplete: true }
  const checklistState = { jobs: [checklistJob] }
  assert.equal((await runtime.admitJob(project, {}, "session-checklist", checklistState, checklistJob)).admitted, true)
  assert.deepEqual(checklistJob.checklistStatus, { status: "pending", total: 2, pending: 1 })

  await writeFile(path.join(project, "TASK.md"), "- [x] code\n- [x] plan\n")
  assert.deepEqual(await runtime.admitJob(project, {}, "session-checklist", checklistState, checklistJob),
    { admitted: false, reason: "checklist_complete" })
  assert.equal(checklistState.jobs.length, 0)
  assert.equal(notifications.at(-1)[2], "checklist_complete")

  const verifyJob = { id: "verify-checklist", enabled: true, progressFile: "TASK.md",
    untilChecklistComplete: true, verifyCommand: "npm test" }
  const verifyState = { jobs: [verifyJob] }
  assert.equal((await runtime.admitJob(project, {}, "session-verify", verifyState, verifyJob)).admitted, true,
    "unchecked host verification cannot imply completion")
  verifyJob.lastVerifyCode = 1
  verifyJob.lastVerifyAt = clock
  assert.equal((await runtime.admitJob(project, {}, "session-verify", verifyState, verifyJob)).admitted, true,
    "failed host verification cannot imply completion")
  verifyJob.lastVerifyCode = 0
  assert.equal((await runtime.admitJob(project, {}, "session-verify", verifyState, verifyJob)).admitted, true,
    "successful verify without recorded checklist fingerprint is not authoritative")
  verifyJob.lastVerifyChecklistDigest = (await inspectTaskChecklist(project, "TASK.md")).digest
  await writeFile(path.join(project, "TASK.md"), "- [x] code\n- [x] plan\n- [x] later task\n")
  assert.equal((await runtime.admitJob(project, {}, "session-verify", verifyState, verifyJob)).admitted, true,
    "verification for older checklist bytes cannot certify newly changed work")
  verifyJob.lastVerifyChecklistDigest = (await inspectTaskChecklist(project, "TASK.md")).digest
  assert.equal((await runtime.admitJob(project, {}, "session-verify", verifyState, verifyJob)).reason, "checklist_complete")

  const missingJob = { id: "missing-checklist", enabled: true, progressFile: "MISSING.md", untilChecklistComplete: true }
  const missingState = { jobs: [missingJob] }
  const missing = await runtime.admitJob(project, {}, "session-missing", missingState, missingJob)
  assert.deepEqual(missing, { admitted: false, reason: "checklist_unavailable" })
  assert.equal(missingJob.paused, true)
  assert.equal(missingJob.lastChecklistError, "file-missing")
  assert.equal(missingState.jobs.length, 1, "preserve job for explicit recovery")
} finally {
  await rm(project, { force: true, recursive: true })
}

console.log("run admission runtime tests passed")
