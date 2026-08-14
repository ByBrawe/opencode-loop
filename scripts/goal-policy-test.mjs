import assert from "node:assert/strict"
import { createGoalExecutionPolicy } from "../src/source/runtime/goal-policy.js"

function goal(id, overrides = {}) {
  return {
    id,
    name: id,
    kind: "goal",
    goalStatus: "active",
    enabled: true,
    paused: false,
    noProgressCount: 0,
    goalProgress: [],
    ...overrides,
  }
}

assert.throws(() => createGoalExecutionPolicy({}), /runShellCommand/)

function policyHarness(shellResults = []) {
  const shellCalls = []
  const toasts = []
  const logs = []
  let clock = 1000
  let shellIndex = 0
  const policy = createGoalExecutionPolicy({
    runShellCommand: async (command, directory, timeoutMs) => {
      shellCalls.push({ command, directory, timeoutMs })
      return shellResults[shellIndex++] || { code: 0, stdout: "ok", stderr: "" }
    },
    dangerousShell: (command) => command.includes("danger"),
    toast: async (_client, message, level) => { toasts.push({ message, level }) },
    appendLoopLog: async (directory, line, extra) => { logs.push({ directory, line, extra }) },
    now: () => ++clock,
  })
  return { ...policy, shellCalls, toasts, logs }
}

{
  const harness = policyHarness()
  const before = goal("progress", { noProgressCount: 2 })
  const after = goal("progress", {
    noProgressCount: 2,
    goalProgress: [{ time: "now", summary: "Implemented change" }],
  })
  const result = await harness.applyGoalNoProgressGuard("/work", {}, "session", after, before)
  assert.equal(result.noProgressCount, 0)
  assert.equal(result.lastProgressAt, 1001)
  assert.equal(harness.logs.length, 0)
  assert.equal(harness.toasts.length, 0)
}

{
  const harness = policyHarness()
  const before = goal("stall", { maxNoProgress: 3, noProgressCount: 1 })
  const current = structuredClone(before)
  const result = await harness.applyGoalNoProgressGuard("/work", {}, "session", current, before)
  assert.equal(result.noProgressCount, 2)
  assert.equal(result.lastNoProgressAt, 1001)
  assert.equal(result.paused, false)
  assert.deepEqual(harness.logs.map((item) => item.line), ["goal-no-progress"])
  assert.equal(harness.toasts.length, 0)
}

{
  const harness = policyHarness()
  const before = goal("pause", { maxNoProgress: 2, noProgressCount: 1 })
  const current = structuredClone(before)
  const result = await harness.applyGoalNoProgressGuard("/work", {}, "session", current, before)
  assert.equal(result.noProgressCount, 2)
  assert.equal(result.paused, true)
  assert.equal(result.lastNoProgressAt, 1001)
  assert.equal(result.goalNoProgressPausedAt, 1002)
  assert.match(result.goalNoProgressReason, /Paused after 2 turn/)
  assert.deepEqual(harness.logs.map((item) => item.line), ["goal-no-progress", "goal-no-progress-paused"])
  assert.deepEqual(harness.toasts.map((item) => item.level), ["warning"])
}

{
  const harness = policyHarness()
  const unchanged = goal("skip", { goalChecks: [] })
  assert.equal(await harness.runGoalChecks("/work", "session", unchanged, {}), unchanged)
  assert.equal(harness.shellCalls.length, 0)
  assert.equal(harness.logs.length, 0)
}

{
  const harness = policyHarness()
  const checked = goal("danger", { safe: true, goalChecks: ["danger command"], failureCount: 0 })
  const result = await harness.runGoalChecks("/work", "session", checked, {})
  assert.equal(harness.shellCalls.length, 0)
  assert.equal(result.lastGoalChecks.length, 1)
  assert.equal(result.lastGoalChecks[0].code, -1)
  assert.equal(result.failureCount, 1)
  assert.match(result.lastVerifyFailure, /Blocked dangerous command in safe mode/)
  assert.deepEqual(harness.toasts.map((item) => item.level), ["warning"])
  assert.deepEqual(harness.logs.map((item) => item.line), ["goal-checks"])
}

{
  const harness = policyHarness([
    { code: 0, stdout: "tests passed", stderr: "" },
    { code: 0, stdout: "types passed", stderr: "" },
  ])
  const checked = goal("pass", {
    safe: true,
    timeoutMs: 12345,
    goalChecks: ["npm test", "npm run check"],
    failureCount: 2,
    goalCompleteWhenChecksPass: true,
  })
  const result = await harness.runGoalChecks("/work", "session", checked, {})
  assert.deepEqual(harness.shellCalls, [
    { command: "npm test", directory: "/work", timeoutMs: 12345 },
    { command: "npm run check", directory: "/work", timeoutMs: 12345 },
  ])
  assert.equal(result.lastGoalCheckAt, 1001)
  assert.equal(result.goalChecksPassedAt, 1002)
  assert.equal(result.goalCompletedAt, 1003)
  assert.equal(result.failureCount, 0)
  assert.equal(result.goalStatus, "completed")
  assert.equal(result.enabled, false)
  assert.equal(result.paused, true)
  assert.equal(result.goalSummary, "All configured goal checks passed.")
  assert.equal(result.goalEvidence, "npm test: exit 0\nnpm run check: exit 0")
  assert.deepEqual(harness.toasts.map((item) => item.level), ["success"])
  assert.deepEqual(harness.logs.map((item) => item.line), ["goal-auto-complete", "goal-checks"])
}

{
  const harness = policyHarness([{ code: 2, stdout: "", stderr: "compile failed" }])
  const checked = goal("fail", { goalChecks: ["npm run build"], failureCount: 4 })
  const result = await harness.runGoalChecks("/work", "session", checked, {})
  assert.equal(result.lastGoalCheckAt, 1001)
  assert.equal(result.failureCount, 5)
  assert.match(result.lastVerifyFailure, /npm run build/)
  assert.match(result.lastVerifyFailure, /exit=2/)
  assert.match(result.lastVerifyFailure, /compile failed/)
  assert.deepEqual(harness.toasts.map((item) => item.level), ["warning"])
  assert.deepEqual(harness.logs.map((item) => item.line), ["goal-checks"])
}

console.log("goal policy tests passed")
