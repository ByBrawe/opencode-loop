import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { readState, writeState } from "../src/source/core/state.js"
import {
  buildGoalPrompt,
  goalReportPath,
  goalReportText,
  writeGoalReport,
  pickGoalJob,
  parseGoalToolText,
  hasConcreteGoalEvidence,
  goalChecksPassed,
  goalRequiresPassingChecks,
  goalProgressSnapshot,
  goalMadeMeaningfulProgress,
  setGoalComplete,
  setGoalBlocked,
  setGoalProgress,
} from "../src/source/runtime/goal-runtime.js"

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-loop-goal-runtime-"))
try {
  await fs.writeFile(path.join(directory, "GOAL.md"), "Ship the tested feature.\n", "utf8")
  await fs.writeFile(path.join(directory, "EXTRA.md"), "Keep compatibility intact.\n", "utf8")
  await fs.writeFile(path.join(directory, "CONTEXT.md"), "Current implementation context.\n", "utf8")

  const job = {
    id: "goal-1",
    name: "feature",
    kind: "goal",
    goalStatus: "active",
    enabled: true,
    paused: false,
    createdAt: new Date(0).toISOString(),
    action: "Implement the feature safely.",
    goalFile: "GOAL.md",
    promptFile: "EXTRA.md",
    includeFiles: ["CONTEXT.md"],
    goalAcceptance: ["Tests pass", "Compatibility remains intact"],
    goalChecks: ["npm test"],
    verifyCommand: "npm run check",
    lastGoalChecks: [{ command: "npm test", code: 1 }],
    lastVerifyFailure: "npm run check failed before the fix",
    goalCompletionRejectedReason: "configured goal checks have not passed yet",
    maxNoProgress: 3,
    noProgressCount: 1,
    goalProgress: [{ time: "2026-08-14T00:00:00.000Z", summary: "Inspected the failing path", next: "Patch it" }],
  }

  const prompt = await buildGoalPrompt(directory, job)
  assert.match(prompt, /EXPERIMENTAL OPENCODE GOAL MODE ITERATION/)
  assert.ok(prompt.includes(path.resolve(directory)))
  assert.ok(prompt.includes("Implement the feature safely."))
  assert.ok(prompt.includes("Ship the tested feature."))
  assert.ok(prompt.includes("Keep compatibility intact."))
  assert.ok(prompt.includes("Current implementation context."))
  assert.ok(prompt.includes("1. Tests pass"))
  assert.ok(prompt.includes("npm test: exit 1"))
  assert.ok(prompt.includes("1/3 recent turn(s) without recorded meaningful progress"))
  assert.ok(prompt.includes("Inspected the failing path"))

  const report = goalReportText({
    ...job,
    goalSummary: "Feature implemented.",
    goalEvidence: "npm test passed and src/index.js was updated",
    runCount: 4,
  })
  assert.ok(report.includes("Status: active"))
  assert.ok(report.includes("Turns: 4"))
  assert.ok(report.includes("## Summary"))
  assert.ok(report.includes("Feature implemented."))
  assert.ok(report.includes("## Latest checks"))
  assert.ok(report.includes("npm test: exit 1"))

  await writeGoalReport(directory, "ses-1", { ...job, goalSummary: "Saved report." })
  const reportPath = goalReportPath(directory, "ses-1", job)
  assert.equal(await fs.readFile(reportPath, "utf8"), goalReportText({ ...job, goalSummary: "Saved report." }))

  const inactive = { id: "goal-old", name: "old", kind: "goal", goalStatus: "blocked", enabled: false }
  const active = { id: "goal-current", name: "current", kind: "goal", goalStatus: "active", enabled: true }
  const state = { jobs: [{ id: "loop", kind: "prompt" }, inactive, active] }
  assert.equal(pickGoalJob(state), active)
  assert.equal(pickGoalJob(state, "current"), active)
  assert.equal(pickGoalJob(state, "1"), inactive)
  assert.equal(pickGoalJob({ jobs: [] }), undefined)

  assert.deepEqual(parseGoalToolText({ summary: "  done  ", evidence: null }, ["summary", "evidence"]), { summary: "done", evidence: "" })
  assert.equal(hasConcreteGoalEvidence("done"), false)
  assert.equal(hasConcreteGoalEvidence("marked complete by /loop-goal-done because I said so"), false)
  assert.equal(hasConcreteGoalEvidence("npm test passed after updating src/index.js"), true)
  assert.equal(hasConcreteGoalEvidence("A sufficiently detailed explanation of the concrete implementation and verification work that was completed successfully."), true)

  assert.equal(goalChecksPassed({ lastGoalChecks: [{ code: 0 }, { code: "0" }] }), true)
  assert.equal(goalChecksPassed({ lastGoalChecks: [{ code: 1 }] }), false)
  assert.equal(goalChecksPassed({}), false)
  assert.equal(goalRequiresPassingChecks({ goalChecks: ["npm test"] }), true)
  assert.equal(goalRequiresPassingChecks({ goalChecks: ["npm test"], goalRequireChecksPass: false }), false)

  const before = { goalStatus: "active", goalProgress: [], goalEvidence: "", lastGoalCheckAt: 0, lastVerifyAt: 0 }
  assert.equal(goalMadeMeaningfulProgress(before, { ...before }), false)
  assert.equal(goalMadeMeaningfulProgress(before, { ...before, goalProgress: [{ time: "now", summary: "changed" }] }), true)
  assert.equal(goalMadeMeaningfulProgress(before, { ...before, goalEvidence: "npm test passed after updating src/index.js" }), true)
  assert.equal(goalMadeMeaningfulProgress(before, { ...before, lastGoalChecks: [{ code: 0 }], lastGoalCheckAt: 10 }), true)
  assert.equal(goalMadeMeaningfulProgress(before, { ...before, lastVerifyAt: 10, lastVerifyCode: 0 }), true)
  assert.equal(goalMadeMeaningfulProgress(before, { ...before, goalStatus: "blocked" }), true)

  assert.deepEqual(goalProgressSnapshot({ goalStatus: "active", goalProgress: [1, 2], goalEvidence: "x", goalChecksPassedAt: 2, lastGoalCheckAt: 3, lastVerifyAt: 4, lastVerifyCode: "0" }), {
    status: "active",
    progressCount: 2,
    evidence: "x",
    checksPassedAt: 2,
    lastGoalCheckAt: 3,
    lastVerifyAt: 4,
    lastVerifyCode: 0,
  })

  const lifecycleGoal = (id, overrides = {}) => ({
    id,
    name: id,
    kind: "goal",
    goalStatus: "active",
    enabled: true,
    paused: false,
    createdAt: new Date(0).toISOString(),
    action: `Goal ${id}`,
    goalChecks: ["npm test"],
    lastGoalChecks: [{ command: "npm test", code: 0 }],
    noProgressCount: 2,
    ...overrides,
  })

  const completeSession = "ses-complete"
  await writeState(directory, completeSession, { jobs: [lifecycleGoal("complete-goal")] })
  const rejected = await setGoalComplete(directory, completeSession, { summary: "Too early", evidence: "done" })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.rejected, true)
  let persisted = await readState(directory, completeSession)
  let persistedJob = persisted.jobs[0]
  assert.equal(persistedJob.goalStatus, "active")
  assert.equal(persistedJob.goalCompletionRejectedCount, 1)
  assert.ok(persistedJob.goalCompletionRejectedAt > 0)
  assert.match(persistedJob.goalCompletionRejectedReason, /concrete evidence is required/)

  const completed = await setGoalComplete(directory, completeSession, {
    summary: "Feature completed",
    evidence: "npm test passed after updating src/index.js",
  })
  assert.equal(completed.ok, true)
  persisted = await readState(directory, completeSession)
  persistedJob = persisted.jobs[0]
  assert.equal(persistedJob.goalStatus, "completed")
  assert.equal(persistedJob.enabled, false)
  assert.equal(persistedJob.paused, true)
  assert.equal(persistedJob.goalSummary, "Feature completed")
  assert.equal(persistedJob.goalEvidence, "npm test passed after updating src/index.js")
  assert.equal(persistedJob.noProgressCount, 0)
  assert.ok(persistedJob.goalCompletedAt > 0)

  const progressSession = "ses-progress"
  await writeState(directory, progressSession, { jobs: [lifecycleGoal("progress-goal")] })
  const progress = await setGoalProgress(directory, progressSession, {
    summary: "  Patched runtime  ",
    next: "  Run tests  ",
    evidence: "  src/index.js updated and npm test prepared  ",
  })
  assert.equal(progress.ok, true)
  persisted = await readState(directory, progressSession)
  persistedJob = persisted.jobs[0]
  assert.equal(persistedJob.goalProgress.length, 1)
  assert.equal(persistedJob.goalProgress[0].summary, "Patched runtime")
  assert.equal(persistedJob.goalProgress[0].next, "Run tests")
  assert.equal(persistedJob.goalProgress[0].evidence, "src/index.js updated and npm test prepared")
  assert.equal(persistedJob.goalEvidence, "src/index.js updated and npm test prepared")
  assert.equal(persistedJob.noProgressCount, 0)
  assert.ok(persistedJob.lastProgressAt > 0)

  const blockedSession = "ses-blocked"
  await writeState(directory, blockedSession, { jobs: [lifecycleGoal("blocked-goal")] })
  const blocked = await setGoalBlocked(directory, blockedSession, {
    reason: "Need credential",
    needed: "API token",
    evidence: "npm test cannot reach service",
  })
  assert.equal(blocked.ok, true)
  persisted = await readState(directory, blockedSession)
  persistedJob = persisted.jobs[0]
  assert.equal(persistedJob.goalStatus, "blocked")
  assert.equal(persistedJob.enabled, false)
  assert.equal(persistedJob.paused, true)
  assert.equal(persistedJob.goalBlockedReason, "Need credential\nNeeded: API token")
  assert.equal(persistedJob.goalEvidence, "npm test cannot reach service")
  assert.ok(persistedJob.goalBlockedAt > 0)

  const missing = await setGoalProgress(directory, "ses-missing", { summary: "nothing" })
  assert.equal(missing.ok, false)
  assert.match(missing.message, /No active experimental goal/)

  console.log("goal runtime tests passed")
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
