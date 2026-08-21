import assert from "node:assert/strict"
import { createRunFinalizationRuntime } from "../src/source/runtime/run-finalization.js"

const noop = async () => {}
assert.throws(() => createRunFinalizationRuntime({}), /runGoalChecks/)
assert.throws(() => createRunFinalizationRuntime({ runGoalChecks: noop }), /applyGoalNoProgressGuard/)
assert.throws(() => createRunFinalizationRuntime({ runGoalChecks: noop, applyGoalNoProgressGuard: noop }), /createCheckpoint/)
assert.throws(() => createRunFinalizationRuntime({ runGoalChecks: noop, applyGoalNoProgressGuard: noop, createCheckpoint: noop }), /scheduleDueWork/)

let clock = 1000
const shellCalls = []
const writes = []
const logs = []
const notifications = []
const toasts = []
const checkpoints = []
const schedules = []
const goalChecks = []
const progressGuards = []
const reports = []

const runtime = createRunFinalizationRuntime({
  runGoalChecks: async (_directory, sessionID, job) => {
    goalChecks.push([sessionID, job.id])
    return { ...job, checksRan: true }
  },
  applyGoalNoProgressGuard: async (_directory, _client, sessionID, job, previousJob) => {
    progressGuards.push([sessionID, job.id, previousJob?.id])
    return { ...job, guardRan: true }
  },
  createCheckpoint: async (...args) => { checkpoints.push(args) },
  scheduleDueWork: async (...args) => { schedules.push(args) },
  now: () => ++clock,
  writeState: async (...args) => { writes.push(args) },
  appendLoopLog: async (...args) => { logs.push(args) },
  runShellCommand: async (command) => {
    shellCalls.push(command)
    if (command.includes("verify-fail")) return { code: 1, stdout: "bad", stderr: "verify error" }
    if (command.includes("post-fail")) return { code: 2, stdout: "post bad", stderr: "post error" }
    return { code: 0, stdout: "ok", stderr: "" }
  },
  notifyJob: async (...args) => { notifications.push(args) },
  toast: async (...args) => { toasts.push(args) },
  writeGoalReport: async (...args) => { reports.push(args) },
  dangerousShell: (command) => command.includes("danger"),
})

const passing = { id: "passing", enabled: true, verifyCommand: "verify-ok", failureCount: 2 }
const passingState = { jobs: [passing] }
const passingResult = await runtime.finalizeJob("/repo", {}, "session-pass", passingState, passing, { id: "before-pass" })
assert.equal(passingResult.lastVerifyCode, 0)
assert.equal(passingResult.failureCount, 0)
assert.equal(passingResult.lastVerifyFailure, "")
assert.equal(writes.at(-1)[2].jobs[0].id, "passing")
assert.equal(checkpoints.at(-1)[2].id, "passing")
assert.equal(schedules.at(-1)[2], "session-pass")
assert.match(toasts.at(-1)[1], /Loop verify passed/)

const failing = {
  id: "failing",
  enabled: true,
  verifyCommand: "verify-fail",
  pauseOnVerifyFail: true,
  failureCount: 0,
}
const failingState = { jobs: [failing] }
await runtime.finalizeJob("/repo", {}, "session-fail", failingState, failing, { id: "before-fail" })
assert.equal(failing.lastVerifyCode, 1)
assert.equal(failing.failureCount, 1)
assert.equal(failing.paused, true)
assert.match(failing.lastVerifyFailure, /verify error/)
assert.equal(notifications.at(-1)[2], "verify_failed")
assert.equal(logs.at(-1)[1], "verify")

const blockedPostrun = {
  id: "blocked-postrun",
  enabled: true,
  postrunCommand: "danger --all",
  safe: true,
}
const blockedState = { jobs: [blockedPostrun] }
const shellCountBeforeBlocked = shellCalls.length
await runtime.finalizeJob("/repo", {}, "session-blocked", blockedState, blockedPostrun, { id: "before-blocked" })
assert.equal(shellCalls.length, shellCountBeforeBlocked)
assert.equal(logs.findLast((entry) => entry[1] === "postrun-blocked")?.[3].command, "danger --all")

const failedPostrun = {
  id: "failed-postrun",
  enabled: true,
  postrunCommand: "post-fail",
  maxFailures: 1,
  failureCount: 0,
}
const failedPostrunState = { jobs: [failedPostrun] }
await runtime.finalizeJob("/repo", {}, "session-post-fail", failedPostrunState, failedPostrun, { id: "before-post-fail" })
assert.equal(failedPostrun.lastPostrunCode, 2)
assert.equal(failedPostrun.failureCount, 1)
assert.equal(failedPostrun.paused, true)
assert.equal(notifications.at(-1)[2], "postrun_failed")

const goal = {
  id: "goal-job",
  kind: "goal",
  enabled: false,
  paused: true,
  goalStatus: "completed",
}
const otherDisabled = { id: "other-disabled", enabled: false }
const goalState = { jobs: [goal, otherDisabled] }
const goalResult = await runtime.finalizeJob("/repo", {}, "session-goal", goalState, goal, { id: "before-goal" })
assert.equal(goalResult.checksRan, true)
assert.equal(goalResult.guardRan, true)
assert.deepEqual(goalChecks.at(-1), ["session-goal", "goal-job"])
assert.deepEqual(progressGuards.at(-1), ["session-goal", "goal-job", "before-goal"])
assert.equal(goalState.jobs.length, 1)
assert.equal(goalState.jobs[0].id, "goal-job")
assert.equal(reports.at(-1)[2].id, "goal-job")

console.log("run finalization runtime tests passed")
